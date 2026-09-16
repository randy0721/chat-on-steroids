/** Platform-specific Desktop contracts share the same native execution owners. */
import type { SurfaceRegistrar } from './kernel.js';
import { registerMacOSDesktopTools } from './tools-desktop-macos.js';
import { registerWindowsDesktopTools } from './tools-desktop-windows.js';

export function registerDesktopTools(reg: SurfaceRegistrar): void {
  // Window2 names are stable product contracts, not a statement about the control host. They are
  // always published so a Mac-hosted chat frozen to a Windows node can use the same Desktop
  // connector. Local non-Windows calls are refused inside the Windows handler; remote calls are
  // intercepted by the execution backend before that local handler can run.
  registerWindowsDesktopTools(reg);
  if (process.platform === 'darwin') registerMacOSDesktopTools(reg);
}
