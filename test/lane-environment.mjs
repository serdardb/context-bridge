// Launcher pins belong to the invoking session, not isolated test fixtures.
// Tests that exercise lane pinning set it explicitly after this import.
delete process.env.CONTEXT_BRIDGE_LANE;
