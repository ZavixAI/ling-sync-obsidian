export interface ForegroundLifecycleEvents {
  onFocus(listener: () => void): void;
  onVisibilityChange(listener: () => void): void;
  isVisible(): boolean;
}

export function registerForegroundLifecycle(
  events: ForegroundLifecycleEvents,
  onResume: () => void,
): void {
  events.onFocus(onResume);
  events.onVisibilityChange(() => {
    if (events.isVisible()) {
      onResume();
    }
  });
}
