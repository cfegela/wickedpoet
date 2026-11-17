-- Only return the poem that the requesting player started when the game is completed
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
        WHERE p.room_id = p_room_id
          AND p.starter_user_id = v_user_id;
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
