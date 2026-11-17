import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: 'wickedpoet' },
  auth: { storage: window.sessionStorage },
});

/**
 * Ensures an anonymous authenticated session exists.
 * If none exists, creates one seamlessly.
 */
export async function ensureAnonymousSession() {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) {
    await supabase.auth.signOut().catch(() => {});
  }

  if (session?.user) {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (!userError && userData?.user) {
      return userData.user;
    }
    await supabase.auth.signOut().catch(() => {});
  }

  const { data: authData, error: authError } = await supabase.auth.signInAnonymously();
  if (authError) throw authError;

  return authData.user;
}

/**
 * Create a new room with host placed in Seat 1.
 */
export async function createRoom(displayName) {
  await ensureAnonymousSession();
  const params = { p_display_name: displayName.trim() };
  let { data, error } = await supabase.rpc('create_room', params);

  if (error && error.message?.includes('foreign key constraint')) {
    await supabase.auth.signOut().catch(() => {});
    await ensureAnonymousSession();
    const retry = await supabase.rpc('create_room', params);
    data = retry.data;
    error = retry.error;
  }

  if (error) throw error;
  return data;
}

/**
 * Concurrency-safe room joining with seat allocation (1-6 players).
 */
export async function joinRoom(roomId, displayName) {
  await ensureAnonymousSession();
  const params = {
    p_room_id: roomId,
    p_display_name: displayName.trim(),
  };
  let { data, error } = await supabase.rpc('join_room', params);

  if (error && error.message?.includes('foreign key constraint')) {
    await supabase.auth.signOut().catch(() => {});
    await ensureAnonymousSession();
    const retry = await supabase.rpc('join_room', params);
    data = retry.data;
    error = retry.error;
  }

  if (error) throw error;
  return data;
}

/**
 * Fetch initial room information and current player list.
 */
export async function fetchRoom(roomId) {
  const [roomRes, playersRes] = await Promise.all([
    supabase.from('rooms').select('*').eq('id', roomId).single(),
    supabase.from('room_players').select('*').eq('room_id', roomId).order('seat_number', { ascending: true }),
  ]);

  if (roomRes.error) throw roomRes.error;
  if (playersRes.error) throw playersRes.error;

  return {
    room: roomRes.data,
    players: playersRes.data || [],
  };
}

/**
 * Lightweight fetch of room turn and status for polling heartbeat.
 */
export async function fetchRoomTurnState(roomId) {
  const { data, error } = await supabase
    .from('rooms')
    .select('id, current_turn_seat, current_round, total_rounds, status, updated_at')
    .eq('id', roomId)
    .single();

  if (error) return null;
  return data;
}

/**
 * Toggle the ready status for the current user.
 */
export async function toggleReady(roomId) {
  const { data, error } = await supabase.rpc('toggle_ready', {
    p_room_id: roomId,
  });

  if (error) throw error;
  return data;
}

/**
 * Start the game (Host only).
 */
export async function startGame(roomId) {
  const { data, error } = await supabase.rpc('start_game', {
    p_room_id: roomId,
  });

  if (error) throw error;
  return data;
}

/**
 * Submit 1-2 lines of poetry for the current round and end turn.
 */
export async function submitPoemTurn(roomId, content) {
  const { data, error } = await supabase.rpc('submit_poem_turn', {
    p_room_id: roomId,
    p_content: content,
  });

  if (error) throw error;
  return data;
}

/**
 * Fetch the full game round state (room, players, prompt, submission status, completed poems).
 */
export async function fetchGameRoundState(roomId) {
  const { data, error } = await supabase.rpc('fetch_game_round_state', {
    p_room_id: roomId,
  });

  if (error) throw error;
  return data;
}

/**
 * Leave a room.
 */
export async function leaveRoom(roomId) {
  const { data, error } = await supabase.rpc('leave_room', {
    p_room_id: roomId,
  });

  if (error) throw error;
  return data;
}

/**
 * Subscribe to realtime table changes for players, room state, and poem submissions.
 */
export function subscribeToRoom(roomId, onPlayersChange, onRoomChange, onLinesChange, onStatusChange) {
  const channel = supabase.channel(`wp-room:${roomId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'wickedpoet',
        table: 'room_players',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        onPlayersChange && onPlayersChange(payload);
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'wickedpoet',
        table: 'rooms',
        filter: `id=eq.${roomId}`,
      },
      (payload) => {
        onRoomChange && onRoomChange(payload);
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'wickedpoet',
        table: 'poem_lines',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        onLinesChange && onLinesChange(payload);
      }
    )
    .subscribe((status) => {
      onStatusChange && onStatusChange(status);
    });

  return () => {
    supabase.removeChannel(channel);
  };
}
