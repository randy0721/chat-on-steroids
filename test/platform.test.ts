import { describe, expect, it } from 'vitest';
import { defaultConfig, effectiveCapabilities } from '../src/main/config.js';
import {
  capabilitiesForPlatform,
  desktopAutomationSupported,
  hostPlatformInfo,
  macOSDesktopAutomationSupported
} from '../src/main/platform.js';
import { surfaceIsUseful } from '../src/main/mcp/surfaces.js';
import { serverInstructions } from '../src/main/mcp/instructions.js';
import { unifiedExecEnvForPlatform } from '../src/main/codex/unified-exec-constants.js';
import { CAPABILITIES, DESKTOP_CAPABILITIES, type Capabilities } from '../src/shared/types.js';

const allCapabilities = (): Capabilities => ({
  browse: true,
  search: true,
  read: true,
  metadata: true,
  create: true,
  edit: true,
  move: true,
  deleteFile: true,
  command: true,
  saveArtifact: true,
  screen: true,
  control: true,
  clipboardRead: true,
  clipboardWrite: true
});

describe('cross-platform product surface', () => {
  it('starts macOS with Core on and Desktop off, and keeps a Desktop the user switched on', () => {
    const config = defaultConfig('darwin', '21.4.0');
    for (const capability of DESKTOP_CAPABILITIES) expect(config.capabilities[capability], capability).toBe(false);
    for (const capability of CAPABILITIES) {
      if (!DESKTOP_CAPABILITIES.includes(capability)) expect(config.capabilities[capability], capability).toBe(true);
    }
    expect(surfaceIsUseful('core', config.capabilities, 'darwin')).toBe(true);
    expect(surfaceIsUseful('desktop', config.capabilities, 'darwin', '21.4.0')).toBe(false);
    // The off default is a stored choice, not a platform mask: switching the group on works.
    const switchedOn = { ...config, capabilities: allCapabilities() };
    expect(effectiveCapabilities(switchedOn, 'darwin', '21.4.0')).toEqual(allCapabilities());
    expect(surfaceIsUseful('desktop', switchedOn.capabilities, 'darwin', '21.4.0')).toBe(true);
  });

  it('keeps Core fully usable while omitting Desktop on Linux', () => {
    const config = defaultConfig('linux');
    expect(config.capabilities).toMatchObject({
      browse: true,
      search: true,
      read: true,
      metadata: true,
      create: true,
      edit: true,
      move: true,
      deleteFile: true,
      command: true,
      screen: false,
      control: false,
      clipboardRead: false,
      clipboardWrite: false
    });
    expect(surfaceIsUseful('core', config.capabilities, 'linux')).toBe(true);
    expect(surfaceIsUseful('desktop', allCapabilities(), 'linux')).toBe(false);
  });

  it('masks stored Windows Desktop grants at runtime without deleting the stored choices', () => {
    const stored = allCapabilities();
    const config = { ...defaultConfig('linux'), capabilities: stored };
    const live = effectiveCapabilities(config, 'linux');

    expect(live.screen).toBe(false);
    expect(live.control).toBe(false);
    expect(live.clipboardRead).toBe(false);
    expect(live.clipboardWrite).toBe(false);
    expect(live.command).toBe(true);
    expect(config.capabilities).toBe(stored);
    expect(config.capabilities.screen).toBe(true);
  });

  it('reports the host family and Desktop support explicitly', () => {
    expect(hostPlatformInfo('win32')).toEqual({ family: 'windows', name: 'Windows', desktopAutomation: true });
    expect(hostPlatformInfo('darwin', '21.4.0')).toEqual({
      family: 'macos',
      name: 'macOS',
      desktopAutomation: true
    });
    expect(hostPlatformInfo('linux')).toEqual({ family: 'linux', name: 'Linux', desktopAutomation: false });
    expect(desktopAutomationSupported('freebsd')).toBe(false);
    expect(capabilitiesForPlatform(allCapabilities(), 'win32')).toEqual(allCapabilities());
  });

  it('keeps the macOS 12.3 native-helper floor separate from the Core app floor', () => {
    expect(macOSDesktopAutomationSupported('21.3.0')).toBe(false);
    expect(macOSDesktopAutomationSupported('21.4.0')).toBe(true);
    expect(macOSDesktopAutomationSupported('22.0.0')).toBe(true);
    expect(desktopAutomationSupported('darwin', '21.3.0')).toBe(false);
    expect(hostPlatformInfo('darwin', '21.3.0').desktopAutomation).toBe(false);
    expect(defaultConfig('darwin', '21.3.0').capabilities.screen).toBe(false);
  });

  it.each(['darwin', 'linux'] as const)('describes the control host while leaving shell semantics to the bound target on %s', (platform) => {
    const instructions = serverInstructions(
      {
        roots: [],
        caps: allCapabilities(),
        readOnly: false,
        sessionTools: false,
        agentTools: false
      },
      'core',
      platform
    );

    expect(instructions).toContain(platform === 'darwin' ? 'Control host: macOS.' : 'Control host: Linux.');
    expect(instructions).toContain('current-turn execution projection is authoritative for target OS, shell, workspace and roots');
    expect(instructions).toContain('On a Windows target, follow PowerShell quoting/operator rules and use Windows-native paths. On a POSIX target, use its normal zsh/bash/sh semantics.');
    expect(instructions).toContain('Chat On Steroids Desktop');
  });

  it('labels a Windows control host without treating it as execution-target authority', () => {
    const instructions = serverInstructions(
      { roots: [], caps: allCapabilities(), readOnly: false, sessionTools: false, agentTools: false },
      'core',
      'win32'
    );
    expect(instructions).toContain('Control host: Windows.');
    expect(instructions).toContain('The client, not the model, selects the execution node.');
    expect(instructions).toContain('On a Windows target, follow PowerShell quoting/operator rules');
    expect(instructions).toContain('For Windows PowerShell targets, native programs do not expand * or ?');
    expect(instructions).toContain('Chat On Steroids Desktop');
  });

  it('uses a UTF-8 locale name native to each POSIX host', () => {
    const environment = (platform: NodeJS.Platform) => new Map(unifiedExecEnvForPlatform(platform));
    expect(environment('linux').get('LC_ALL')).toBe('C.UTF-8');
    expect(environment('darwin').get('LC_ALL')).toBe('en_US.UTF-8');
  });
});
