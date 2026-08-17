export function resolveNpmInvocation({
  platform = process.platform,
  nodeExecutable = process.execPath,
  npmExecPath = process.env.npm_execpath,
  comspec = process.env.ComSpec ?? process.env.COMSPEC,
} = {}) {
  if (npmExecPath) {
    return {
      executable: nodeExecutable,
      prefixArgs: [npmExecPath],
      strategy: 'NODE_NPM_CLI',
    };
  }

  if (platform === 'win32') {
    return {
      executable: comspec || 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', 'npm'],
      strategy: 'WINDOWS_CMD_FALLBACK',
    };
  }

  return {
    executable: 'npm',
    prefixArgs: [],
    strategy: 'PATH_NPM',
  };
}
