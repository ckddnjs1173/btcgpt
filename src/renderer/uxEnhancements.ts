type QuickTarget = {
  label: string;
  resolve: () => Element | null;
};

function findPanelByText(text: string): Element | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('.panel')).find((panel) =>
      panel.textContent?.includes(text),
    ) ?? null
  );
}

function scrollToTarget(resolve: QuickTarget['resolve']) {
  const target = resolve();
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function installUxEnhancements() {
  if (document.getElementById('app-quick-nav')) return;

  const targets: QuickTarget[] = [
    {
      label: '시장',
      resolve: () => document.querySelector('.workspace-grid'),
    },
    {
      label: 'GPT·거래',
      resolve: () => document.querySelector('.gpt-panel'),
    },
    {
      label: '연결',
      resolve: () => findPanelByText('CLOUDFLARE RELAY'),
    },
    {
      label: '설정',
      resolve: () => document.querySelector('.settings-layout'),
    },
    {
      label: '맨 위',
      resolve: () => document.querySelector('.topbar'),
    },
  ];

  const nav = document.createElement('nav');
  nav.id = 'app-quick-nav';
  nav.className = 'app-quick-nav';
  nav.setAttribute('aria-label', '화면 빠른 이동');

  for (const target of targets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = target.label;
    button.addEventListener('click', () => scrollToTarget(target.resolve));
    nav.append(button);
  }

  document.body.append(nav);
}
