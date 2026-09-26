/**
 * Salam resolution.
 *
 * Indexes small Salam projects end to end and checks that references land on
 * the right symbols: file imports (a package spans every file that declares
 * it), package imports, Persian aliases (`@fa`) and receivers typed by struct
 * literals, parameters or the return type of the function that made them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('Salam resolution', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-salam-'));
  });

  afterEach(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function calleeNames(fromName: string, file: string): string[] {
    const from = cg.getNodesInFile(file).find((n) => n.name === fromName);
    if (!from) throw new Error(`no ${fromName} in ${file}`);
    return cg.getCallees(from.id).map((c) => `${c.node.filePath}#${c.node.name}`);
  }

  it('resolves calls through file imports, package spans, package aliases and Persian aliases', async () => {
    write('lib/geometry.salam', `@en "geometry"
@fa "هندسه"
package geometry

@en "Area"
@fa "مساحت"
pub func Area(w: int, h: int): int:
    ret w * h
end
`);
    write('lib/util.salam', `package util

pub func Twice(n: int): int:
    ret Helper(n) * 2
end
`);
    write('lib/util_more.salam', `package util

pub func Helper(n: int): int:
    ret n
end
`);
    write('app/main.salam', `import util "../lib/util.salam"
import geometry

func run(): int:
    ret util.Twice(2) + geometry.Area(2, 3)
end
`);
    write('lib/shapes.salam', `package shapes

pub struct Point:
    pub x: int
    pub func length(): int:
        ret this.x
    end
    pub func scale(k: int): int:
        ret this.x * k
    end
    pub func shift(k: int): int:
        ret this.x + k
    end
end

pub func Origin(): Point:
    ret Point { x = 0 }
end
`);
    write('app/measure.salam', `import shapes

func measure(): int:
    a := shapes.Point { x = 1 }
    b := shapes.Origin()
    ret a.length() + b.scale(2)
end

func norm(p: shapes.Point): int:
    ret p.shift(1)
end
`);
    write('app/fa.salam', `// زبان: فارسی
فراخوانی هندسه

کارکرد آغازین:
    چاپ هندسه.مساحت(2, 3)
پایان
`);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.resolveReferences();

    expect(calleeNames('run', 'app/main.salam')).toEqual(
      expect.arrayContaining(['lib/util.salam#Twice', 'lib/geometry.salam#Area']),
    );
    // Helper lives in a sibling file of the same package
    expect(calleeNames('Twice', 'lib/util.salam')).toContain('lib/util_more.salam#Helper');
    // The Persian spelling reaches the same function
    expect(calleeNames('آغازین', 'app/fa.salam')).toContain('lib/geometry.salam#Area');
    // A receiver typed by a struct literal, by a factory's return type, and by a parameter
    expect(calleeNames('measure', 'app/measure.salam')).toEqual(
      expect.arrayContaining(['lib/shapes.salam#length', 'lib/shapes.salam#scale']),
    );
    expect(calleeNames('norm', 'app/measure.salam')).toContain('lib/shapes.salam#shift');
  });

  it('indexes .salam files as their own language', async () => {
    write('a.salam', 'func main:\n    println "hi"\nend\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    expect(cg.getStats().filesByLanguage.salam).toBe(1);
  });
});
