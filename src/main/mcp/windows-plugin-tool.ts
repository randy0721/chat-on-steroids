import { z } from 'zod';
import { pluginManager } from '../plugins/manager.js';
import { getConfig } from '../config.js';
import { toolDeclaration } from './tool-declarations.js';
import { fail, guard, ok, type SurfaceRegistrar, type ToolResult } from './kernel.js';

const WINDOWS_PLUGIN_NAME = 'Windows Desktop Commander';

function windowsPlugin() {
  return pluginManager.snapshot().plugins.find(
    (plugin) => plugin.name.trim().toLowerCase() === WINDOWS_PLUGIN_NAME.toLowerCase()
  );
}

function callableTools() {
  const plugin = windowsPlugin();
  if (!plugin) return { plugin: undefined, tools: [] };
  return {
    plugin,
    tools: plugin.tools.filter((tool) => tool.enabled && tool.published !== false)
  };
}

/**
 * One bounded Core entry point for the remote Windows Desktop Commander plugin.
 *
 * The external MCP server still owns the actual schemas, validation and execution. Core
 * intentionally exposes only this wrapper so a user can keep one ChatGPT connector while
 * avoiding 30+ Desktop Commander schemas in every Core discovery response.
 */
export function registerWindowsPluginTool(reg: SurfaceRegistrar): void {
  reg.register(
    'windows',
    toolDeclaration('windows', () => ({
      title: 'Remote Windows computer',
      description:
        'Call the installed "Windows Desktop Commander" plugin to work on the remote Windows PC. ' +
        'Use action="list_tools" first when you need the exact Desktop Commander action names. ' +
        'For any other action, pass that tool name plus its arguments object unchanged. ' +
        'This targets the remote Windows machine, not the local Mac running Chat On Steroids.',
      inputSchema: z
        .object({
          action: z
            .string()
            .min(1)
            .max(100)
            .describe('Desktop Commander tool name, or "list_tools" to inspect the available remote Windows actions.'),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Arguments passed unchanged to the selected Desktop Commander tool. Omit for list_tools or tools with no arguments.')
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    })),
    ({ action, arguments: toolArgs }) =>
      guard('windows', async () => {
        if (getConfig().readOnly) {
          return fail('TOOL_DISABLED: remote Windows tools are unavailable while CoS read-only mode is on.');
        }

        const { plugin, tools } = callableTools();
        if (!plugin) {
          return fail(
            `WINDOWS_PLUGIN_MISSING: install and enable a CoS plugin named "${WINDOWS_PLUGIN_NAME}" in Settings → Plugins.`
          );
        }
        if (!plugin.enabled || plugin.status !== 'ready') {
          return fail(
            `WINDOWS_PLUGIN_UNAVAILABLE: "${WINDOWS_PLUGIN_NAME}" is ${plugin.status}. Open Settings → Plugins and reconnect it before retrying.`
          );
        }

        if (action === 'list_tools') {
          if (tools.length === 0) return fail('WINDOWS_PLUGIN_UNAVAILABLE: no enabled Desktop Commander tools are currently published.');
          const lines = tools.map((tool) => `- ${tool.exposedName}${tool.description ? `: ${tool.description}` : ''}`);
          return ok(`Available Windows Desktop Commander actions (${tools.length}):\n${lines.join('\n')}`);
        }

        const tool = tools.find((candidate) => candidate.exposedName === action || candidate.name === action);
        if (!tool) {
          const names = tools.map((candidate) => candidate.exposedName).slice(0, 50).join(', ');
          return fail(
            `WINDOWS_ACTION_UNAVAILABLE: "${action}" is not an enabled Windows Desktop Commander action. ` +
              `Use action="list_tools" to inspect the current set.${names ? ` Available now: ${names}` : ''}`
          );
        }

        return (await pluginManager.call(tool.exposedName, toolArgs ?? {})) as ToolResult;
      })
  );
}
