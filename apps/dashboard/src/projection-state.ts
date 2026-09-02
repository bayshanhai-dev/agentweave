export type DashboardSnapshot<T> = {
  schemaVersion: 1;
  cursor: number;
  workstream: T;
};

export function isProjectionGap(lastCursor: number, incomingCursor: number): boolean {
  return incomingCursor > 0 && incomingCursor !== lastCursor + 1;
}

export function reconcileSnapshot<T>(snapshot: DashboardSnapshot<T>): T {
  if (snapshot.schemaVersion !== 1 || !snapshot.workstream) {
    throw new Error("unsupported_dashboard_snapshot");
  }
  return snapshot.workstream;
}
