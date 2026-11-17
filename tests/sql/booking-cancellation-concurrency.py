"""Run ONLY against our disposable local Docker container, never a remote DB."""
from concurrent.futures import ThreadPoolExecutor
import subprocess

CONTAINER = 'cut-culture-cancel-test'


def sql(statement):
    result = subprocess.run(
        ['docker', 'exec', '-i', CONTAINER, 'psql', '-X', '-q', '-t', '-A',
         '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
        input=statement, text=True, capture_output=True, timeout=30, check=True,
    )
    return result.stdout.strip()


# This schema exists only in the disposable container; no production URLs/keys.
try:
    sql('''CREATE SCHEMA cut_culture_cancel_concurrency;
      CREATE TABLE cut_culture_cancel_concurrency.bookings (id bigint PRIMARY KEY, status text);
      INSERT INTO cut_culture_cancel_concurrency.bookings VALUES (1, 'confirmed');''')
    statement = '''WITH changed AS (
      UPDATE cut_culture_cancel_concurrency.bookings SET status = 'cancelled'
      WHERE id = 1 AND status = 'confirmed' RETURNING id
    ) SELECT count(*) FROM changed;'''
    with ThreadPoolExecutor(max_workers=2) as pool:
        counts = sorted(pool.map(lambda _: sql(statement), [0, 1]))
    assert counts == ['0', '1'], 'Expected exactly one successful concurrent cancel'
    assert sql('SELECT status FROM cut_culture_cancel_concurrency.bookings WHERE id=1;') == 'cancelled'
    print('PASS: two concurrent cancellations changed exactly one row')
finally:
    sql('DROP SCHEMA IF EXISTS cut_culture_cancel_concurrency CASCADE;')
