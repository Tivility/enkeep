export interface EventCursor {
  id: string;
  userId: string; // Tenant/Owner ID
  routeId: string; // Scoped to route/session
  consumer: string; // Consumer identity (e.g. 'platform', 'relay', 'default')
  cursorValue: string;
  updatedAt: string;
}

export interface SetEventCursorInput {
  userId: string;
  routeId: string;
  consumer?: string; // Defaults to 'default'
  cursorValue: string;
}
