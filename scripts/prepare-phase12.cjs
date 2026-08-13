const fs = require('node:fs');

const path = 'src/renderer/App.tsx';
const source = fs.readFileSync(path, 'utf8');
const actual = `          {settings.tradingMode === 'PAPER' &&
            snapshot?.trading.activePlan?.status === 'LOCKED' && (
              <button onClick={() => void enterPaperTrade()}>
                고정 계획으로 PAPER 진입
              </button>
            )}`;
const expected = `          {settings.tradingMode === 'PAPER' &&
                    snapshot?.trading.activePlan?.status === 'LOCKED' && (
                      <button onClick={() => void enterPaperTrade()}>
                        고정 계획으로 PAPER 진입
                      </button>
                    )}`;
if (!source.includes(actual)) throw new Error('PAPER entry button source not found');
fs.writeFileSync(path, source.replace(actual, expected));
