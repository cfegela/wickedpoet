-- Wicked Poet Schema & Core Multiplayer Gameplay
CREATE SCHEMA IF NOT EXISTS wickedpoet;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Grant schema usage and default privileges for Supabase API roles
GRANT USAGE ON SCHEMA wickedpoet TO anon, authenticated, service_role;

-- 1. Rooms Table
CREATE TABLE IF NOT EXISTS wickedpoet.rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'in_progress', 'completed', 'abandoned')),
    max_players INT NOT NULL DEFAULT 6 CHECK (max_players >= 1 AND max_players <= 6),
    current_turn_seat INT NOT NULL DEFAULT 1,
    current_round INT NOT NULL DEFAULT 1,
    total_rounds INT NOT NULL DEFAULT 2,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wp_rooms_status ON wickedpoet.rooms(status);
CREATE INDEX IF NOT EXISTS idx_wp_rooms_created_at ON wickedpoet.rooms(created_at);

-- 2. Room Players Table
CREATE TABLE IF NOT EXISTS wickedpoet.room_players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES wickedpoet.rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name VARCHAR(24) NOT NULL,
    seat_number INT NOT NULL CHECK (seat_number >= 1 AND seat_number <= 6),
    is_host BOOLEAN NOT NULL DEFAULT false,
    is_ready BOOLEAN NOT NULL DEFAULT false,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_wp_room_seat UNIQUE (room_id, seat_number),
    CONSTRAINT uq_wp_room_user UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wp_room_players_room_id ON wickedpoet.room_players(room_id);
CREATE INDEX IF NOT EXISTS idx_wp_room_players_user_id ON wickedpoet.room_players(user_id);

-- 3. Poems Table (1 poem per player in the room)
CREATE TABLE IF NOT EXISTS wickedpoet.poems (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES wickedpoet.rooms(id) ON DELETE CASCADE,
    poem_index INT NOT NULL,
    starter_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_wp_room_poem_index UNIQUE (room_id, poem_index)
);

CREATE INDEX IF NOT EXISTS idx_wp_poems_room_id ON wickedpoet.poems(room_id);

-- 4. Poem Lines Table (1 contribution per player per round)
CREATE TABLE IF NOT EXISTS wickedpoet.poem_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES wickedpoet.rooms(id) ON DELETE CASCADE,
    poem_id UUID NOT NULL REFERENCES wickedpoet.poems(id) ON DELETE CASCADE,
    round_number INT NOT NULL,
    author_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    author_name VARCHAR(24) NOT NULL,
    seat_number INT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_wp_poem_round UNIQUE (poem_id, round_number),
    CONSTRAINT uq_wp_room_round_author UNIQUE (room_id, round_number, author_user_id)
);

CREATE INDEX IF NOT EXISTS idx_wp_poem_lines_room_round ON wickedpoet.poem_lines(room_id, round_number);
CREATE INDEX IF NOT EXISTS idx_wp_poem_lines_poem_id ON wickedpoet.poem_lines(poem_id);

-- Enable RLS
ALTER TABLE wickedpoet.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE wickedpoet.room_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE wickedpoet.poems ENABLE ROW LEVEL SECURITY;
ALTER TABLE wickedpoet.poem_lines ENABLE ROW LEVEL SECURITY;

-- Table grants
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA wickedpoet TO authenticated, service_role;
GRANT SELECT ON wickedpoet.rooms, wickedpoet.room_players TO anon;

-- Realtime Publication
ALTER PUBLICATION supabase_realtime ADD TABLE wickedpoet.rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE wickedpoet.room_players;
ALTER PUBLICATION supabase_realtime ADD TABLE wickedpoet.poem_lines;

-- RLS Policies
CREATE POLICY "Anyone authenticated can view rooms"
    ON wickedpoet.rooms FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Host can update room"
    ON wickedpoet.rooms FOR UPDATE
    TO authenticated
    USING (auth.uid() = host_id)
    WITH CHECK (auth.uid() = host_id);

CREATE POLICY "Anyone authenticated can view room players"
    ON wickedpoet.room_players FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Users can update their own player state"
    ON wickedpoet.room_players FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can leave room"
    ON wickedpoet.room_players FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Room players can view poems"
    ON wickedpoet.poems FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM wickedpoet.room_players rp
            WHERE rp.room_id = poems.room_id AND rp.user_id = auth.uid()
        )
    );

CREATE POLICY "Players can view own lines or all lines once completed"
    ON wickedpoet.poem_lines FOR SELECT
    TO authenticated
    USING (
        auth.uid() = author_user_id
        OR EXISTS (
            SELECT 1 FROM wickedpoet.rooms r
            WHERE r.id = poem_lines.room_id AND r.status = 'completed'
        )
    );

-- Helper: Truncate text to the last few words for the next player's prompt
CREATE OR REPLACE FUNCTION wickedpoet.truncate_prompt(p_text TEXT, p_word_count INT DEFAULT 4)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_clean TEXT;
    v_words TEXT[];
    v_len INT;
    v_start INT;
    v_slice TEXT;
BEGIN
    v_clean := trim(regexp_replace(COALESCE(p_text, ''), '\s+', ' ', 'g'));
    IF v_clean = '' THEN
        RETURN '';
    END IF;

    v_words := string_to_array(v_clean, ' ');
    v_len := array_length(v_words, 1);

    IF v_len IS NULL OR v_len = 0 THEN
        RETURN '';
    END IF;

    IF v_len <= p_word_count THEN
        RETURN v_clean;
    END IF;

    v_start := v_len - p_word_count + 1;
    v_slice := array_to_string(v_words[v_start:v_len], ' ');
    RETURN '...' || v_slice;
END;
$$;

-- RPC: Create Room
CREATE OR REPLACE FUNCTION wickedpoet.create_room(p_display_name TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wickedpoet, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_clean_name TEXT;
    v_room wickedpoet.rooms%ROWTYPE;
    v_player wickedpoet.room_players%ROWTYPE;
    v_recent_room_count INT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT COUNT(*) INTO v_recent_room_count
    FROM wickedpoet.rooms
    WHERE host_id = v_user_id
      AND created_at > (now() - INTERVAL '10 minutes');

    IF v_recent_room_count >= 10 THEN
        RAISE EXCEPTION 'Rate limit exceeded: You can only create up to 10 rooms every 10 minutes.';
    END IF;

    v_clean_name := trim(p_display_name);
    IF length(v_clean_name) < 1 OR length(v_clean_name) > 20 THEN
        RAISE EXCEPTION 'Display name must be between 1 and 20 characters.';
    END IF;

    INSERT INTO wickedpoet.rooms (host_id, status, max_players, current_turn_seat, current_round, total_rounds)
    VALUES (v_user_id, 'waiting', 6, 1, 1, 2)
    RETURNING * INTO v_room;

    INSERT INTO wickedpoet.room_players (room_id, user_id, display_name, seat_number, is_host, is_ready)
    VALUES (v_room.id, v_user_id, v_clean_name, 1, true, true)
    RETURNING * INTO v_player;

    RETURN json_build_object(
        'room', row_to_json(v_room),
        'player', row_to_json(v_player)
    );
END;
$$;

-- RPC: Join Room (Concurrency safe with row lock)
CREATE OR REPLACE FUNCTION wickedpoet.join_room(p_room_id UUID, p_display_name TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wickedpoet, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_clean_name TEXT;
    v_room wickedpoet.rooms%ROWTYPE;
    v_player wickedpoet.room_players%ROWTYPE;
    v_player_count INT;
    v_assigned_seat INT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    v_clean_name := trim(p_display_name);
    IF length(v_clean_name) < 1 OR length(v_clean_name) > 20 THEN
        RAISE EXCEPTION 'Display name must be between 1 and 20 characters.';
    END IF;

    SELECT * INTO v_room
    FROM wickedpoet.rooms
    WHERE id = p_room_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Room not found.';
    END IF;

    -- Reconnection / page refresh check
    SELECT * INTO v_player
    FROM wickedpoet.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id;

    IF FOUND THEN
        UPDATE wickedpoet.room_players
        SET display_name = v_clean_name, last_seen_at = now()
        WHERE id = v_player.id
        RETURNING * INTO v_player;

        RETURN json_build_object(
            'room', row_to_json(v_room),
            'player', row_to_json(v_player),
            'reconnected', true
        );
    END IF;

    IF v_room.status != 'waiting' THEN
        RAISE EXCEPTION 'Game is already % and cannot be joined.', v_room.status;
    END IF;

    SELECT COUNT(*) INTO v_player_count
    FROM wickedpoet.room_players
    WHERE room_id = p_room_id;

    IF v_player_count >= v_room.max_players THEN
        RAISE EXCEPTION 'Room is full (maximum % players reached).', v_room.max_players;
    END IF;

    SELECT s.seat INTO v_assigned_seat
    FROM generate_series(1, v_room.max_players) AS s(seat)
    WHERE s.seat NOT IN (
        SELECT seat_number FROM wickedpoet.room_players WHERE room_id = p_room_id
    )
    ORDER BY s.seat ASC
    LIMIT 1;

    INSERT INTO wickedpoet.room_players (room_id, user_id, display_name, seat_number, is_host, is_ready)
    VALUES (p_room_id, v_user_id, v_clean_name, v_assigned_seat, false, false)
    RETURNING * INTO v_player;

    RETURN json_build_object(
        'room', row_to_json(v_room),
        'player', row_to_json(v_player),
        'reconnected', false
    );
END;
$$;

-- RPC: Toggle Ready
CREATE OR REPLACE FUNCTION wickedpoet.toggle_ready(p_room_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wickedpoet, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_player wickedpoet.room_players%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    UPDATE wickedpoet.room_players
    SET is_ready = NOT is_ready,
        last_seen_at = now()
    WHERE room_id = p_room_id AND user_id = v_user_id
    RETURNING * INTO v_player;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player not found in room.';
    END IF;

    RETURN json_build_object('player', row_to_json(v_player));
END;
$$;

-- RPC: Leave Room
CREATE OR REPLACE FUNCTION wickedpoet.leave_room(p_room_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wickedpoet, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_remaining_count INT;
    v_was_host BOOLEAN;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT is_host INTO v_was_host
    FROM wickedpoet.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id;

    IF v_was_host THEN
        UPDATE wickedpoet.rooms
        SET status = 'abandoned', updated_at = now()
        WHERE id = p_room_id;

        DELETE FROM wickedpoet.room_players
        WHERE room_id = p_room_id;
    ELSE
        DELETE FROM wickedpoet.room_players
        WHERE room_id = p_room_id AND user_id = v_user_id;

        SELECT COUNT(*) INTO v_remaining_count
        FROM wickedpoet.room_players
        WHERE room_id = p_room_id;

        IF v_remaining_count = 0 THEN
            UPDATE wickedpoet.rooms
            SET status = 'abandoned', updated_at = now()
            WHERE id = p_room_id;
        END IF;
    END IF;

    RETURN json_build_object('success', true, 'was_host', COALESCE(v_was_host, false));
END;
$$;

-- RPC: Start Game (Host only)
CREATE OR REPLACE FUNCTION wickedpoet.start_game(p_room_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wickedpoet, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_room wickedpoet.rooms%ROWTYPE;
    v_player_count INT;
    v_idx INT := 0;
    v_rec RECORD;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_room
    FROM wickedpoet.rooms
    WHERE id = p_room_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Room not found';
    END IF;

    IF v_room.host_id != v_user_id THEN
        RAISE EXCEPTION 'Only the host can start the game';
    END IF;

    IF v_room.status != 'waiting' THEN
        RAISE EXCEPTION 'Game is already %', v_room.status;
    END IF;

    SELECT COUNT(*) INTO v_player_count
    FROM wickedpoet.room_players
    WHERE room_id = p_room_id;

    IF v_player_count < 1 THEN
        RAISE EXCEPTION 'At least 1 player is required to start the game';
    END IF;

    -- Create 1 poem per player in seat order
    FOR v_rec IN
        SELECT user_id
        FROM wickedpoet.room_players
        WHERE room_id = p_room_id
        ORDER BY seat_number ASC
    LOOP
        INSERT INTO wickedpoet.poems (room_id, poem_index, starter_user_id)
        VALUES (p_room_id, v_idx, v_rec.user_id);
        v_idx := v_idx + 1;
    END LOOP;

    -- Total rounds = double the number of players
    UPDATE wickedpoet.rooms
    SET status = 'in_progress',
        current_turn_seat = 1,
        current_round = 1,
        total_rounds = v_player_count * 2,
        updated_at = now()
    WHERE id = p_room_id
    RETURNING * INTO v_room;

    RETURN json_build_object(
        'success', true,
        'room', row_to_json(v_room)
    );
END;
$$;

-- RPC: Submit Poem Turn for Current Round
CREATE OR REPLACE FUNCTION wickedpoet.submit_poem_turn(p_room_id UUID, p_content TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wickedpoet, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_room wickedpoet.rooms%ROWTYPE;
    v_player wickedpoet.room_players%ROWTYPE;
    v_clean_content TEXT;
    v_player_count INT;
    v_player_idx INT;
    v_poem_index INT;
    v_poem wickedpoet.poems%ROWTYPE;
    v_submitted_count INT;
    v_round_advanced BOOLEAN := false;
    v_game_completed BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    v_clean_content := trim(COALESCE(p_content, ''));
    IF length(v_clean_content) < 1 THEN
        RAISE EXCEPTION 'Please write at least 1 character of poetry before ending your turn.';
    END IF;
    IF length(v_clean_content) > 400 THEN
        RAISE EXCEPTION 'Entry is too long (maximum 400 characters).';
    END IF;

    SELECT * INTO v_room
    FROM wickedpoet.rooms
    WHERE id = p_room_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Room not found.';
    END IF;

    IF v_room.status != 'in_progress' THEN
        RAISE EXCEPTION 'Game is not in progress.';
    END IF;

    SELECT * INTO v_player
    FROM wickedpoet.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'You are not a player in this room.';
    END IF;

    -- Prevent duplicate submission for this round
    IF EXISTS (
        SELECT 1 FROM wickedpoet.poem_lines
        WHERE room_id = p_room_id
          AND round_number = v_room.current_round
          AND author_user_id = v_user_id
    ) THEN
        RAISE EXCEPTION 'You have already submitted your lines for Round %.', v_room.current_round;
    END IF;

    -- Determine player's 0-based index in seat order
    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE seat_number < v_player.seat_number)
    INTO v_player_count, v_player_idx
    FROM wickedpoet.room_players
    WHERE room_id = p_room_id;

    v_poem_index := (((v_player_idx - (v_room.current_round - 1)) % v_player_count) + v_player_count) % v_player_count;

    SELECT * INTO v_poem
    FROM wickedpoet.poems
    WHERE room_id = p_room_id AND poem_index = v_poem_index;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assigned poem not found.';
    END IF;

    INSERT INTO wickedpoet.poem_lines (
        room_id, poem_id, round_number, author_user_id, author_name, seat_number, content
    ) VALUES (
        p_room_id, v_poem.id, v_room.current_round, v_user_id, v_player.display_name, v_player.seat_number, v_clean_content
    );

    -- Check if all players have finished this round
    SELECT COUNT(*) INTO v_submitted_count
    FROM wickedpoet.poem_lines
    WHERE room_id = p_room_id AND round_number = v_room.current_round;

    IF v_submitted_count >= v_player_count THEN
        IF v_room.current_round >= v_room.total_rounds THEN
            UPDATE wickedpoet.rooms
            SET status = 'completed',
                updated_at = now()
            WHERE id = p_room_id
            RETURNING * INTO v_room;
            v_game_completed := true;
        ELSE
            UPDATE wickedpoet.rooms
            SET current_round = v_room.current_round + 1,
                updated_at = now()
            WHERE id = p_room_id
            RETURNING * INTO v_room;
            v_round_advanced := true;
        END IF;
    END IF;

    RETURN json_build_object(
        'success', true,
        'room', row_to_json(v_room),
        'round_advanced', v_round_advanced,
        'game_completed', v_game_completed
    );
END;
$$;

-- RPC: Fetch Game Round State
CREATE OR REPLACE FUNCTION wickedpoet.fetch_game_round_state(p_room_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wickedpoet, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_room wickedpoet.rooms%ROWTYPE;
    v_player wickedpoet.room_players%ROWTYPE;
    v_players json;
    v_submitted_user_ids json;
    v_my_submitted BOOLEAN := false;
    v_player_count INT;
    v_player_idx INT;
    v_poem_index INT;
    v_poem_id UUID;
    v_prev_line wickedpoet.poem_lines%ROWTYPE;
    v_truncated_prompt TEXT := NULL;
    v_previous_author_name TEXT := NULL;
    v_completed_poems json := NULL;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_room
    FROM wickedpoet.rooms
    WHERE id = p_room_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Room not found.';
    END IF;

    SELECT * INTO v_player
    FROM wickedpoet.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player not in room.';
    END IF;

    SELECT COALESCE(json_agg(row_to_json(rp) ORDER BY rp.seat_number ASC), '[]'::json)
    INTO v_players
    FROM wickedpoet.room_players rp
    WHERE rp.room_id = p_room_id;

    SELECT COALESCE(json_agg(pl.author_user_id), '[]'::json)
    INTO v_submitted_user_ids
    FROM wickedpoet.poem_lines pl
    WHERE pl.room_id = p_room_id AND pl.round_number = v_room.current_round;

    SELECT EXISTS (
        SELECT 1 FROM wickedpoet.poem_lines pl
        WHERE pl.room_id = p_room_id
          AND pl.round_number = v_room.current_round
          AND pl.author_user_id = v_user_id
    ) INTO v_my_submitted;

    IF v_room.status = 'in_progress' AND v_room.current_round > 1 THEN
        SELECT COUNT(*),
               COUNT(*) FILTER (WHERE seat_number < v_player.seat_number)
        INTO v_player_count, v_player_idx
        FROM wickedpoet.room_players
        WHERE room_id = p_room_id;

        v_poem_index := (((v_player_idx - (v_room.current_round - 1)) % v_player_count) + v_player_count) % v_player_count;

        SELECT id INTO v_poem_id
        FROM wickedpoet.poems
        WHERE room_id = p_room_id AND poem_index = v_poem_index;

        IF v_poem_id IS NOT NULL THEN
            SELECT * INTO v_prev_line
            FROM wickedpoet.poem_lines
            WHERE poem_id = v_poem_id AND round_number = v_room.current_round - 1;

            IF FOUND THEN
                v_truncated_prompt := wickedpoet.truncate_prompt(v_prev_line.content, 4);
                v_previous_author_name := v_prev_line.author_name;
            END IF;
        END IF;
    END IF;

    IF v_room.status = 'completed' THEN
        SELECT COALESCE(
            json_agg(
                json_build_object(
                    'id', p.id,
                    'poem_index', p.poem_index,
                    'lines', (
                        SELECT COALESCE(
                            json_agg(
                                json_build_object(
                                    'round_number', pl.round_number,
                                    'author_name', pl.author_name,
                                    'seat_number', pl.seat_number,
                                    'content', pl.content
                                ) ORDER BY pl.round_number ASC
                            ),
                            '[]'::json
                        )
                        FROM wickedpoet.poem_lines pl
                        WHERE pl.poem_id = p.id
                    )
                ) ORDER BY p.poem_index ASC
            ),
            '[]'::json
        )
        INTO v_completed_poems
        FROM wickedpoet.poems p
        WHERE p.room_id = p_room_id;
    END IF;

    RETURN json_build_object(
        'room', row_to_json(v_room),
        'players', v_players,
        'my_submitted', v_my_submitted,
        'submitted_user_ids', v_submitted_user_ids,
        'truncated_prompt', v_truncated_prompt,
        'previous_author_name', v_previous_author_name,
        'completed_poems', v_completed_poems
    );
END;
$$;

-- Grant execute permissions on all functions in wickedpoet schema
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA wickedpoet TO authenticated, service_role;
