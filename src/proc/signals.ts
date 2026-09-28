/**
 * Resolves with the first SIGINT or SIGTERM this process receives. Its handlers are then removed, so a second signal
 * ends the process the default way (the reaper then cleans up).
 */
export function firstSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals) => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve(signal);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}
