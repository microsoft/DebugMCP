import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface AgentInfo {
    id: string;
    name: string;
    displayName: string;
    configPath: string;
    mcpServerFieldName: string; 
}

export interface MCPServerConfig {
    autoApprove: string[];
    disabled: boolean;
    timeout: number;
    type: string;
    url: string;
}

export class AgentConfigurationManager {
    private static readonly DEBUGMCP_CONFIG: MCPServerConfig = {
        autoApprove: [],
        disabled: false,
        timeout: 60,
        type: "sse",
        url: "http://localhost:3001/sse"
    };

    /**
     * Get list of supported agents
     */
    async getSupportedAgents(): Promise<AgentInfo[]> {
        const userHome = os.homedir();
        const appDataPath = process.env.APPDATA || path.join(userHome, 'AppData', 'Roaming');
        
        const agents: AgentInfo[] = [
            {
                id: 'cline',
                name: 'cline',
                displayName: 'Cline',
                configPath: path.join(appDataPath, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'copilot',
                name: 'copilot',
                displayName: 'GitHub Copilot',
                configPath: path.join(appDataPath, 'Code', 'User', 'mcp.json'),
                mcpServerFieldName: 'servers'
            },
            {
                id: 'cursor',
                name: 'cursor',
                displayName: 'Cursor',
                configPath: path.join(appDataPath, 'Cursor', 'User', 'globalStorage', 'cursor.mcp', 'settings', 'mcp_settings.json'),
                mcpServerFieldName: 'mcpServers'
            }
        ];

        return agents;
    }

    /**
     * Add DebugMCP server configuration to the specified agent's config
     */
    async addDebugMCPToAgent(agent: AgentInfo): Promise<boolean> {
        try {
            // Ensure the config directory exists
            const configDir = path.dirname(agent.configPath);
            if (!fs.existsSync(configDir)) {
                await fs.promises.mkdir(configDir, { recursive: true });
            }

            let config: any = {};
            
            // Read existing config if it exists
            if (fs.existsSync(agent.configPath)) {
                const configContent = await fs.promises.readFile(agent.configPath, 'utf8');
                try {
                    config = JSON.parse(configContent);
                } catch (parseError) {
                    console.warn(`Failed to parse existing config for ${agent.name}, creating new config`);
                    config = {};
                }
            }

            // Ensure the correct MCP servers object exists for this agent
            const fieldName = agent.mcpServerFieldName;
            if (!config[fieldName]) {
                config[fieldName] = {};
            }

            // Add or update DebugMCP configuration
            config[fieldName].debugmcp = AgentConfigurationManager.DEBUGMCP_CONFIG;

            // Write the updated config back to file
            await fs.promises.writeFile(
                agent.configPath, 
                JSON.stringify(config, null, 2), 
                'utf8'
            );

            console.log(`Successfully added DebugMCP configuration to ${agent.name}`);
            return true;
        } catch (error) {
            console.error(`Error adding DebugMCP to ${agent.name}:`, error);
            vscode.window.showErrorMessage(`Failed to configure DebugMCP for ${agent.displayName}: ${error}`);
            return false;
        }
    }

    /**
     * Check if DebugMCP is already configured for an agent
     */
    async isDebugMCPConfigured(agent: AgentInfo): Promise<boolean> {
        try {
            if (!fs.existsSync(agent.configPath)) {
                return false;
            }

            const configContent = await fs.promises.readFile(agent.configPath, 'utf8');
            const config = JSON.parse(configContent);

            const fieldName = agent.mcpServerFieldName;
            return !!(config[fieldName] && config[fieldName].debugmcp);
        } catch (error) {
            console.error(`Error checking DebugMCP configuration for ${agent.name}:`, error);
            return false;
        }
    }

    /**
     * Remove DebugMCP configuration from an agent
     */
    async removeDebugMCPFromAgent(agent: AgentInfo): Promise<boolean> {
        try {
            if (!fs.existsSync(agent.configPath)) {
                return true; // Nothing to remove
            }

            const configContent = await fs.promises.readFile(agent.configPath, 'utf8');
            const config = JSON.parse(configContent);

            const fieldName = agent.mcpServerFieldName;
            if (config[fieldName] && config[fieldName].debugmcp) {
                delete config[fieldName].debugmcp;
                
                await fs.promises.writeFile(
                    agent.configPath,
                    JSON.stringify(config, null, 2),
                    'utf8'
                );
            }

            return true;
        } catch (error) {
            console.error(`Error removing DebugMCP from ${agent.name}:`, error);
            return false;
        }
    }
}
