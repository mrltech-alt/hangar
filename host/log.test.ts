import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileLogger, rotateIfLarge } from './log.ts';
import { tempDir } from '../test/fixtures/tmp.ts';


const at = () => new Date('2026-09-07T10:00:00.000Z');

describe('createFileLogger', () => {
  it('appends timestamped lines', () => {
    const dir = tempDir('log');
    const file = join(dir, 'host.log');
    const log = createFileLogger(file, { now: at });
    log.write('hello');
    log.write('world');
    log.close();
    expect(readFileSync(file, 'utf8')).toBe('2026-09-07T10:00:00.000Z hello\n2026-09-07T10:00:00.000Z world\n');
  });
});

describe('createFileLogger rotation while running', () => {
  // The host is detached and outlives app restarts, and host/main.ts logs a full stack on every
  // uncaughtException without exiting — so at-open-only rotation lets host.log grow without bound
  // for the life of the process.
  it('rotates mid-run and loses nothing across the boundary', () => {
    const dir = tempDir('log-roll');
    const file = join(dir, 'host.log');
    const log = createFileLogger(file, { now: at, limitBytes: 200 });
    for (let i = 0; i < 20; i++) log.write(`line ${i} ${'x'.repeat(40)}`);
    log.close();

    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(200);
    // Not just "something rotated": the newest lines must survive, in order, across the pair.
    const both = readFileSync(`${file}.1`, 'utf8') + readFileSync(file, 'utf8');
    expect(both).toContain('line 19 ');
    expect(both.indexOf('line 18 ')).toBeLessThan(both.indexOf('line 19 '));
  });

  it('counts pre-existing bytes, so an already-large file rotates on its first write', () => {
    const dir = tempDir('log-pre');
    const file = join(dir, 'host.log');
    writeFileSync(file, 'x'.repeat(190));
    const log = createFileLogger(file, { now: at, limitBytes: 200 });
    log.write('now over the limit');
    log.close();
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  // A throw here is not survivable: inside an uncaughtException handler it kills the daemon, and
  // from close() in shutdown() it skips process.exit(0) after the pidfile is already gone.
  it('keeps working when rotation is impossible, instead of bricking the descriptor', () => {
    const dir = tempDir('log-ro');
    const file = join(dir, 'host.log');
    const log = createFileLogger(file, { now: at, limitBytes: 100 });
    log.write('before');
    chmodSync(dir, 0o500); // no writes to the directory: rename and create both fail
    try {
      expect(() => {
        for (let i = 0; i < 10; i++) log.write(`after ${i} ${'y'.repeat(40)}`);
      }).not.toThrow();
      expect(() => log.close()).not.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(file, 'utf8')).toContain('after 9 ');
  });
});

describe('rotateIfLarge', () => {
  it('renames the file to .1 when over the limit', () => {
    const dir = tempDir('log');
    const file = join(dir, 'host.log');
    writeFileSync(file, 'x'.repeat(100));
    expect(rotateIfLarge(file, 50)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(statSync(`${file}.1`).size).toBe(100);
    expect(rotateIfLarge(file, 50)).toBe(false);
  });

  it('shifts generations down and drops the oldest when keep > 1 (spec §5.2, app.log)', () => {
    const dir = tempDir('log-keep');
    const file = join(dir, 'app.log');
    for (const gen of ['first', 'second', 'third', 'fourth']) {
      writeFileSync(file, `${gen}${'x'.repeat(100)}`);
      expect(rotateIfLarge(file, 50, 3)).toBe(true);
    }
    expect(readFileSync(`${file}.1`, 'utf8')).toContain('fourth');
    expect(readFileSync(`${file}.2`, 'utf8')).toContain('third');
    expect(readFileSync(`${file}.3`, 'utf8')).toContain('second');
    expect(existsSync(`${file}.4`)).toBe(false); // 'first' dropped
  });
});
