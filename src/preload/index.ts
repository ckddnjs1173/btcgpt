import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  type DesktopApi,
  type WriteDatabaseCheckInput,
} from '../shared/contracts';

const desktopApi: DesktopApi = {
  getPhaseZeroStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getPhaseZeroStatus),
  testNotification: () => ipcRenderer.invoke(IPC_CHANNELS.testNotification),
  copyText: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.copyText, text),
  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  writeDbCheck: (input: WriteDatabaseCheckInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.writeDbCheck, input),
  readDbCheck: () => ipcRenderer.invoke(IPC_CHANNELS.readDbCheck),
};

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
