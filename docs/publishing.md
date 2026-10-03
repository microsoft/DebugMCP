# Publishing DebugMCP

Run these commands from the **repository root**, with dependencies installed
(`npm ci`). Before publishing, update the appropriate version: root `package.json`
for the extension, or `npm/cli/package.json` for npm.

## VS Code Marketplace

```powershell
npx vsce package
```

Upload the generated `.vsix` manually as an update at
[the ozzafar publisher page](https://marketplace.visualstudio.com/manage/publishers/ozzafar).

## Open VSX Registry

With `ovsx` installed and your Open VSX access token configured (`OVSX_PAT`):

```powershell
ovsx publish
```

## npm

Stay at the **repository root**, not `src\cli` or `npm\cli`:

```powershell
npm login
npm run cli:publish
```

The root script builds and publishes `npm/cli`. Use a full repository checkout
containing `esbuild.js`; an installed extension or a copied CLI folder is not enough.
