-- TEST ONLY: run in an isolated PostgreSQL instance. All changes roll back.
BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TEMP TABLE cancel_test_bookings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  barber_id bigint NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text DEFAULT 'confirmed',
  CONSTRAINT bookings_valid_time CHECK (ends_at > starts_at),
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    barber_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'confirmed')
);
DO $test$
DECLARE original_id bigint; changed integer;
BEGIN
  INSERT INTO cancel_test_bookings(barber_id, starts_at, ends_at)
  VALUES (1, '2026-12-01 10:00+03', '2026-12-01 11:00+03') RETURNING id INTO original_id;
  BEGIN
    INSERT INTO cancel_test_bookings(barber_id, starts_at, ends_at)
    VALUES (1, '2026-12-01 10:30+03', '2026-12-01 11:30+03');
    RAISE EXCEPTION 'FAIL: overlapping active record accepted';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  UPDATE cancel_test_bookings SET status = 'cancelled' WHERE id = original_id AND status = 'confirmed';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'FAIL: first cancel must change one row'; END IF;
  UPDATE cancel_test_bookings SET status = 'cancelled' WHERE id = original_id AND status = 'confirmed';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'FAIL: repeated cancel changed a row'; END IF;
  IF NOT EXISTS (SELECT FROM cancel_test_bookings WHERE id = original_id AND status = 'cancelled') THEN
    RAISE EXCEPTION 'FAIL: cancellation must preserve the row';
  END IF;
  -- The exact same slot is free after cancellation.
  INSERT INTO cancel_test_bookings(barber_id, starts_at, ends_at)
  VALUES (1, '2026-12-01 10:00+03', '2026-12-01 11:00+03');
  BEGIN
    INSERT INTO cancel_test_bookings(barber_id, starts_at, ends_at)
    VALUES (1, '2026-12-01 10:30+03', '2026-12-01 11:30+03');
    RAISE EXCEPTION 'FAIL: overlap protection lost after cancellation';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- Half-open intervals allow the next appointment at exactly the prior end.
  INSERT INTO cancel_test_bookings(barber_id, starts_at, ends_at)
  VALUES (1, '2026-12-01 11:00+03', '2026-12-01 12:00+03');
  BEGIN
    INSERT INTO cancel_test_bookings(barber_id, starts_at, ends_at)
    VALUES (2, '2026-12-01 12:00+03', '2026-12-01 11:00+03');
    RAISE EXCEPTION 'FAIL: invalid interval accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS: cancellation preserves rows, frees slot, rejects repeat and retains overlap/time constraints';
END $test$;
ROLLBACK;
