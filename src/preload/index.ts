import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  type DesktopApi,
  type AccountConfigurationInput,
  type ManualPositionInput,
  type PositionCalculationInput,
  type UserSettings,
  type RelayConfigurationInput,
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
  getMarketStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getMarketStatus),
  getLatestSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getLatestSnapshot),
  configureAccount: (input: AccountConfigurationInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.configureAccount, input),
  disconnectAccount: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectAccount),
  getAccountStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getAccountStatus),
  saveManualPosition: (input: ManualPositionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveManualPosition, input),
  clearManualPosition: () =>
    ipcRenderer.invoke(IPC_CHANNELS.clearManualPosition),
  getManualPosition: () => ipcRenderer.invoke(IPC_CHANNELS.getManualPosition),
  getRelayStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getRelayStatus),
  getUserSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getUserSettings),
  saveUserSettings: (settings: UserSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveUserSettings, settings),
  calculatePositionPlan: (input: PositionCalculationInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.calculatePositionPlan, input),
  lockTradePlan: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.lockTradePlan, input),
  getTradingState: () => ipcRenderer.invoke(IPC_CHANNELS.getTradingState),
  enterPaperTrade: () => ipcRenderer.invoke(IPC_CHANNELS.enterPaperTrade),
  partiallyClosePaperTrade: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.partiallyClosePaperTrade, input),
  closePaperTrade: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.closePaperTrade, input),
  configureRelay: (input: RelayConfigurationInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.configureRelay, input),
  disconnectRelay: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectRelay),
  resetLocalData: () => ipcRenderer.invoke(IPC_CHANNELS.resetLocalData),
  configureNaver: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.configureNaver, input),
  disconnectNaver: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectNaver),
};

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
