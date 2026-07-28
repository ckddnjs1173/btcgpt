import { Menu, Tray, nativeImage } from 'electron';

const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA4klEQVR4nO1XMQ7CMAykwNCBCalTxQ/5Q9U/9ItMfIClomsaYvviJLoO3BZV9l18rpN0t/vjeyLizCQ/hICrJ+g9r+K3Ybpk5erQHtBIS8RAFnjI0ThTgJccjVct0IL752u3/iyjSiTZIVagdOdovqSA2uRa3h8LJPK45BY0S0I76IPoWAJaeR8j5KFXAD4L4qbKnQMS6BWgC4AtsOaA1xJ6BXYCci8TXvwnYYjkfQCZiN6mi21OVqBVL6TyihbUFiHlM2/FNQ4obTNmE5ZWwoqH/gKvCCQOfpiEoLyMWoE+iDZb1E8Pfhw1OgAAAABJRU5ErkJggg==';

interface CreateTrayOptions {
  showWindow: () => void;
  quitApplication: () => void;
}

export function createAppTray({
  showWindow,
  quitApplication,
}: CreateTrayOptions): Tray {
  const icon = nativeImage
    .createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'))
    .resize({ width: 16, height: 16 });
  const tray = new Tray(icon);

  tray.setToolTip('BTC Futures Assistant · 시장 감시');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '대시보드 열기',
        click: showWindow,
      },
      { type: 'separator' },
      {
        label: 'BTCUSDT 시장 감시',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: '앱 종료',
        click: quitApplication,
      },
    ]),
  );
  tray.on('double-click', showWindow);

  return tray;
}
