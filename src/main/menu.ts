import { Menu, app, type MenuItemConstructorOptions } from 'electron';

export function installMenu(opts: { quitAndStopAgents: () => Promise<void>; restartSessionHost: () => Promise<void>; isDev: boolean }): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Hangar',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        // §14's "explicit restart action", and the one two code paths already name in prose: the
        // protocol-mismatch toast in `index.ts` and `checkProtocolVersion`'s read-only banner both
        // say "Restart it from Hangar → Restart Session Host". Without this item that instruction
        // was unfollowable and `host:restart` had no entry point at all. Ellipsis: it confirms
        // first, because it stops the user's running agents.
        { label: 'Restart Session Host…', click: () => void opts.restartSessionHost() },
        { type: 'separator' },
        { label: 'Quit and Stop All Agents', accelerator: 'CmdOrCtrl+Shift+Q', click: () => void opts.quitAndStopAgents() },
        { role: 'quit', label: 'Quit (agents keep running)' },
      ],
    },
    { role: 'editMenu' }, // copy/paste/select-all reach xterm through the standard roles
    {
      label: 'View',
      submenu: opts.isDev ? [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] : [{ role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setName('Hangar');
}
