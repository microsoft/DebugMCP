// Copyright (c) Microsoft Corporation.

/**
 * Redaction of secret-looking runtime values before they leave the extension.
 *
 * Debug adapters happily hand back every variable in scope, which routinely
 * includes API keys, tokens, passwords and whole `os.environ` / `process.env`
 * dumps. Those values are then streamed to an AI agent (and usually to a remote
 * model provider). This module scrubs values that look like credentials so
 * inspecting program state does not exfiltrate them.
 *
 * The heuristics are deliberately conservative in one direction: values that
 * are empty, null-ish or otherwise carry no secret material are left intact so
 * "why is my token undefined?" remains debuggable.
 */

export const REDACTION_PLACEHOLDER = '<redacted: possible secret>';

export const REDACTION_NOTICE =
    `NOTE: values matching '${REDACTION_PLACEHOLDER}' were withheld because their name or ` +
    'content looks like a credential (key, token, password, connection string, ...). ' +
    'Use debug-specific checks (type, length, is-null) instead of reading the raw value.';

/**
 * Names that mark a variable as credential-bearing.
 *
 * Matched *exactly* (case-insensitively, ignoring `_`/`-` separators) rather
 * than as substrings: a substring rule flags any name merely containing
 * 'token' or 'cookie', so benign variables like `tokenCount` or `cookieCount`
 * get withheld and stop being debuggable.
 *
 * The cost of exact matching is that arbitrary compound names are no longer
 * inferred, so widely used compound forms are listed explicitly below.
 */
const SENSITIVE_NAMES = new Set([
    // Keys
    'apikey', 'apikeys', 'apisecret', 'apisecretkey', 'accesskey', 'accesskeyid',
    'secretkey', 'secretaccesskey', 'privatekey', 'publicprivatekey', 'encryptionkey',
    'signingkey', 'sessionkey', 'masterkey', 'clientkey', 'sshkey', 'gpgkey', 'saskey',
    // Secrets
    'secret', 'secrets', 'clientsecret', 'consumersecret',
    // Passwords
    'password', 'passwords', 'passwd', 'pwd', 'pass', 'passphrase',
    'dbpassword', 'dbpasswd', 'dbpass', 'rootpassword', 'adminpassword', 'userpassword',
    // Tokens
    'token', 'tokens', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'apitoken',
    'sessiontoken', 'bearertoken', 'bearer', 'oauthtoken', 'personalaccesstoken',
    'csrftoken', 'xsrftoken', 'sastoken', 'jwt',
    // Credentials / auth
    'credential', 'credentials', 'authorization', 'auth', 'otp',
    // Sessions and cookies
    'cookie', 'cookies', 'sessionid',
    // Connection strings
    'connectionstring', 'connstr', 'accountkey', 'sasurl',
    // Common environment-variable spellings
    'openaiapikey', 'anthropicapikey', 'awssecretaccesskey', 'awsaccesskeyid',
    'awssessiontoken', 'githubtoken', 'ghtoken', 'gitlabtoken', 'npmtoken', 'slacktoken',
    'azurestoragekey', 'googleapikey'
]);

/**
 * Fold a name to its comparison form: case and `_`/`-`/space separators carry
 * no meaning, so `API_KEY`, `api-key` and `apiKey` are all `apikey`.
 */
function normalizeName(name: string): string {
    return name.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Well-known credential shapes. These are redacted regardless of the variable
 * name, because a secret assigned to `x` is still a secret.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
    // PEM blocks. The body is matched with a base64/whitespace class (not `[\s\S]*?`)
    // so the match is unambiguous and linear, and so an unterminated block still has
    // its key material consumed rather than only its header.
    /-----BEGIN[A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]*(?:-----END[A-Z ]*PRIVATE KEY-----)?/g,
    /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g,                     // JWTs
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{12,}\b/g,                            // AWS key ids
    /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,                                                // GitHub tokens
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[abopsr]-[A-Za-z0-9-]{10,}\b/g,                                             // Slack tokens
    /\bAIza[0-9A-Za-z_-]{30,}\b/g,                                                    // Google API keys
    /\bsk-(?:[A-Za-z0-9_-]+-)?[A-Za-z0-9]{16,}\b/g,                                   // OpenAI / Anthropic style
    /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g,                                      // Stripe
    /\bnpm_[A-Za-z0-9]{30,}\b/g,
    /\bglpat-[A-Za-z0-9_-]{16,}\b/g,                                                  // GitLab
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(?:AccountKey|SharedAccessSignature|Password|Pwd)\s*=\s*[^;\s'"]+/gi           // connection strings
];

/** Values that cannot carry a secret and stay readable for debugging. */
const TRIVIAL_VALUES = new Set([
    '', 'none', 'null', 'nil', 'undefined', 'nan', 'true', 'false',
    '0', '-1', '[]', '{}', '()', 'empty', '<empty>'
]);

/** Quote/decoration stripping so `'None'` and `None` are treated alike. */
function unwrap(value: string): string {
    let text = value.trim();
    while (text.length >= 2 &&
        ((text.startsWith("'") && text.endsWith("'")) ||
            (text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith('`') && text.endsWith('`')))) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

function isTrivialValue(value: string): boolean {
    return TRIVIAL_VALUES.has(unwrap(value).toLowerCase());
}

export function isSensitiveName(name: string | undefined | null): boolean {
    if (!name) {
        return false;
    }
    return SENSITIVE_NAMES.has(normalizeName(name));
}

export function isSensitiveExpression(expression: string | undefined | null): boolean {
    if (!expression) {
        return false;
    }
    const identifiers = expression.match(/[A-Za-z_][A-Za-z0-9_-]*/g);
    return identifiers !== null && isSensitiveName(identifiers[identifiers.length - 1]);
}

export function looksLikeSecretValue(value: string | undefined | null): boolean {
    if (!value) {
        return false;
    }
    return SECRET_VALUE_PATTERNS.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(value);
    });
}

/**
 * Redact a single variable value based on its name and content.
 * Returns the (possibly rewritten) value and whether anything was withheld.
 *
 * The decision is made from the variable itself - its own name and its own
 * value - and never by descending into the entries of a structure. A struct
 * whose name is not a credential name is returned intact, even if some field
 * inside it is called `password`; scrub the field by inspecting it directly.
 */
export function redactVariableValue(name: string | undefined, value: unknown): { value: string; redacted: boolean } {
    const text = value === undefined || value === null ? '' : String(value);

    if (text === '' || isTrivialValue(text)) {
        return { value: text, redacted: false };
    }

    if (isSensitiveName(name)) {
        return { value: REDACTION_PLACEHOLDER, redacted: true };
    }

    if (looksLikeSecretValue(text)) {
        // A recognizable credential shape, whatever the variable is called.
        return { value: REDACTION_PLACEHOLDER, redacted: true };
    }

    return { value: text, redacted: false };
}

/**
 * Redact free-form debugger output (for example an `evaluate` result), which is
 * the trivial bypass for per-variable redaction: `evaluate_expression` on
 * `os.environ` or `process.env.API_KEY` returns the same secrets.
 */
export function redactExpressionResult(expression: string, value: unknown): { value: string; redacted: boolean } {
    const text = value === undefined || value === null ? '' : String(value);

    if (text === '' || isTrivialValue(text)) {
        return { value: text, redacted: false };
    }

    if (isSensitiveExpression(expression)) {
        return { value: REDACTION_PLACEHOLDER, redacted: true };
    }

    if (looksLikeSecretValue(text)) {
        return { value: REDACTION_PLACEHOLDER, redacted: true };
    }

    return { value: text, redacted: false };
}
