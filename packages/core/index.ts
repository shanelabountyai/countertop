// The domain engine: pure functions, no database, no clock (CLAUDE.md).
//
// What lands here, and in which session:
//   C-002  menu/  + pricing/  — the modifier model and the price engine
//   C-003  (schema lives in packages/db; the snapshot shape is decided there)
//   C-004  orders/            — the ONE order state machine every reader
//                               derives its status lists from
//
// Nothing is exported yet. C-001 is the scaffold only.
export {};
