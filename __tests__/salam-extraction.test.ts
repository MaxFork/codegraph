/**
 * Salam (.salam) extraction.
 *
 * Salam has no tree-sitter grammar here: a lexer + recursive-descent parser
 * follow the compiler's own rules (English and Persian keyword sets, multi-word
 * identifiers, layout DSL). These tests pin the symbols and references that
 * come out, both keyword generations of Persian, and error recovery. Linking
 * those references across files is covered in salam-resolution.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { extractFromSource } from '../src/extraction';
import {
  detectLanguage,
  getLanguageDisplayName,
  getSupportedLanguages,
  isLanguageSupported,
  isSourceFile,
} from '../src/extraction/grammars';
import { SalamExtractor } from '../src/extraction/salam-extractor';
import { lexSalam } from '../src/extraction/salam-lexer';
import type { ExtractionResult, Node } from '../src/types';

const ENGLISH = `// Shapes and helpers
package shapes

import str
import mx "math.salam"

const MAX := 100
mut counter := 0
limit := 5

type NodeId = int

enum Color: Red, Green = 5, Blue end

interface Shape:
    func area(): f64
    func name(): str
end

// A 2D point
pub struct Point:
    pub x: int
    pub y: int = 0
    pub func length(): int:
        ret this.x + this.y
    end
end

struct Stack<T>:
    items: Vector<T> = Vector {}
    pub func size(): int: ret this.items.len() end
end

impl Shape on Point:
    func area(): f64: ret 1.0 end
    func name(): str: ret "point" end
end

extern:
    func puts(s: str): int
end

func helper(x: int): int: ret x end

func make counter(start: int): int:
    p := Point { x = start }
    total := mx.Square(start) + p.length()
    s := str.Upper("a")
    v := Vector {} as Vector<int>
    v.push(1)
    f := (x: int) => helper(x)
    each i in v:
        println i
    end
    ret total
end
`;

function extract(file: string, source: string): ExtractionResult {
  return extractFromSource(file, source);
}

function byName(result: ExtractionResult, name: string): Node {
  const node = result.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`no node named ${name}: ${result.nodes.map((n) => n.name).join(', ')}`);
  return node;
}

function refs(result: ExtractionResult, kind: string): string[] {
  return result.unresolvedReferences.filter((r) => r.referenceKind === kind).map((r) => r.referenceName);
}

describe('Salam language detection', () => {
  it('maps .salam to salam and treats it as a source file', () => {
    expect(detectLanguage('src/main.salam')).toBe('salam');
    expect(isSourceFile('src/main.salam')).toBe(true);
    expect(isLanguageSupported('salam')).toBe(true);
    expect(getSupportedLanguages()).toContain('salam');
    expect(getLanguageDisplayName('salam')).toBe('Salam');
  });
});

describe('Salam lexer', () => {
  it('reads keywords from the marker language, not from the other set', () => {
    const en = lexSalam('func main:\nend\n', 'en').toks.filter((t) => t.t === 'kw').map((t) => t.v);
    expect(en).toEqual(['func', 'end']);
    const fa = lexSalam('کارکرد آغازین:\nپایان\n', 'fa').toks.filter((t) => t.t === 'kw').map((t) => t.v);
    expect(fa).toEqual(['func', 'end']);
  });

  it('ends a statement at a newline unless the line continues', () => {
    const toks = lexSalam('x := 1 +\n    2\ny := 3\n', 'en').toks;
    expect(toks.filter((t) => t.t === 'end')).toHaveLength(2);
  });

  it('folds a ZWNJ inside an identifier to a space and keeps digits in words', () => {
    const toks = lexSalam('اعشار۶۴ نام‌خانوادگی', 'fa').toks.filter((t) => t.t === 'id').map((t) => t.v);
    expect(toks).toEqual(['اعشار۶۴', 'نام خانوادگی']);
  });

  it('reads `تا` as until outside a repeat header and `to` inside it (renamed Persian set)', () => {
    const toks = lexSalam('تا x:\nپایان\nتکرار 1 تا 3 از i:\nپایان\n', 'fa2').toks.filter((t) => t.t === 'kw').map((t) => t.v);
    expect(toks).toEqual(['until', 'end', 'repeat', 'to', 'in', 'end']);
  });
});

describe('Salam extraction (English)', () => {
  const result = extract('shapes/shapes.salam', ENGLISH);

  it('parses without errors and tags the file', () => {
    const ex = new SalamExtractor('shapes/shapes.salam', ENGLISH);
    ex.extract();
    expect(ex.syntaxErrorMessages).toEqual([]);
    expect(ex.keywordLanguage).toBe('en');
    expect(result.errors).toEqual([]);
    expect(result.nodes[0]).toMatchObject({ kind: 'file', language: 'salam', id: 'file:shapes/shapes.salam' });
  });

  it('extracts the package and qualifies its symbols with it', () => {
    expect(byName(result, 'shapes')).toMatchObject({ kind: 'module' });
    expect(byName(result, 'helper').qualifiedName).toBe('shapes::helper');
    expect(byName(result, 'length').qualifiedName).toBe('shapes::Point::length');
  });

  it('extracts declarations with kinds, visibility and export', () => {
    expect(byName(result, 'MAX')).toMatchObject({ kind: 'constant', isExported: false });
    expect(byName(result, 'counter')).toMatchObject({ kind: 'variable', decorators: ['mut'] });
    expect(byName(result, 'limit')).toMatchObject({ kind: 'variable' });
    expect(byName(result, 'NodeId')).toMatchObject({ kind: 'type_alias' });
    expect(byName(result, 'Color')).toMatchObject({ kind: 'enum' });
    expect(result.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.name)).toEqual(['Red', 'Green', 'Blue']);
    expect(byName(result, 'Point')).toMatchObject({ kind: 'struct', isExported: true, visibility: 'public' });
    expect(byName(result, 'Stack')).toMatchObject({ kind: 'struct', typeParameters: ['T'], isExported: false });
    expect(byName(result, 'Shape')).toMatchObject({ kind: 'interface' });
    expect(byName(result, 'x')).toMatchObject({ kind: 'field', visibility: 'public' });
    expect(byName(result, 'items')).toMatchObject({ kind: 'field', visibility: 'private' });
  });

  it('keeps multi-word function names and captures signatures and return types', () => {
    const fn = byName(result, 'make counter');
    expect(fn).toMatchObject({ kind: 'function', returnType: 'int' });
    expect(fn.signature).toBe('func make counter(start: int): int');
  });

  it('extracts interface signatures, impl blocks and extern functions', () => {
    const area = result.nodes.find((n) => n.name === 'area' && n.isAbstract);
    expect(area).toMatchObject({ kind: 'method', qualifiedName: 'shapes::Shape::area' });
    expect(byName(result, 'impl Shape on Point')).toMatchObject({ kind: 'namespace' });
    const implArea = result.nodes.find((n) => n.name === 'area' && !n.isAbstract);
    expect(implArea).toMatchObject({ kind: 'method', qualifiedName: 'shapes::Point::area' });
    expect(byName(result, 'puts')).toMatchObject({ kind: 'function', decorators: ['extern'] });
  });

  it('records line ranges that cover the whole body', () => {
    const fn = byName(result, 'make counter');
    const lines = ENGLISH.split('\n');
    expect(lines[fn.startLine - 1]).toContain('func make counter');
    expect(lines[fn.endLine - 1]).toBe('end');
    const point = byName(result, 'Point');
    expect(lines[point.startLine - 1]).toContain('pub struct Point');
    expect(lines[point.endLine - 1]).toBe('end');
  });

  it('attaches leading comments as docstrings', () => {
    expect(byName(result, 'Point').docstring).toBe('A 2D point');
  });

  it('links contained members with contains edges', () => {
    const point = byName(result, 'Point');
    const contained = result.edges.filter((e) => e.source === point.id && e.kind === 'contains').map((e) => e.target);
    expect(contained).toContain(byName(result, 'x').id);
    expect(contained).toContain(byName(result, 'length').id);
  });

  it('emits calls with the receiver typed from what the code reveals', () => {
    const calls = refs(result, 'calls');
    expect(calls).toContain('helper'); // inside a lambda
    expect(calls).toContain('mx.Square'); // file-import alias
    expect(calls).toContain('str::Upper'); // package import
    expect(calls).toContain('Point.length'); // receiver typed by a struct literal
  });

  it('drops built-in Vector/HashMap intrinsics instead of guessing a target', () => {
    const calls = refs(result, 'calls');
    expect(calls).not.toContain('v.push');
    expect(calls).not.toContain('push');
    expect(calls).not.toContain('len');
    expect(calls).not.toContain('items.len');
  });

  it('emits instantiates, references, implements and imports refs', () => {
    expect(refs(result, 'instantiates')).toContain('Point');
    expect(refs(result, 'references')).toContain('Point'); // impl target
    const impl = result.unresolvedReferences.find((r) => r.referenceKind === 'implements');
    expect(impl?.referenceName).toBe('Shape');
    expect(impl?.fromNodeId).toBe(byName(result, 'Point').id); // struct in the same file
    const imports = refs(result, 'imports');
    expect(imports).toContain('str');
    expect(imports).toContain('shapes/math.salam'); // relative to the importing file
  });

  it('does not reference primitives, type parameters or locals', () => {
    const references = refs(result, 'references');
    for (const primitive of ['int', 'str', 'f64', 'T', 'p', 'total', 'start']) {
      expect(references).not.toContain(primitive);
    }
  });
});

describe('Salam extraction (Persian)', () => {
  it('reads the released Persian keyword set', () => {
    const source = `// زبان: فارسی
بسته نمونه

فراخوانی رشته

ساختار نقطه:
    همگانی الف: صحیح
    همگانی کارکرد طول(): صحیح:
        بازگشت این.الف
    پایان
پایان

همگانی کارکرد آغازین:
    گذرا مجموع := 0
    چرخه 3 با i: مجموع = مجموع + i پایان
    چاپ مجموع
پایان
`;
    const ex = new SalamExtractor('nemone.salam', source);
    const result = ex.extract();
    expect(ex.syntaxErrorMessages).toEqual([]);
    expect(ex.keywordLanguage).toBe('fa');
    expect(byName(result, 'نمونه')).toMatchObject({ kind: 'module' });
    expect(byName(result, 'نقطه')).toMatchObject({ kind: 'struct', qualifiedName: 'نمونه::نقطه' });
    expect(byName(result, 'طول')).toMatchObject({ kind: 'method', returnType: 'صحیح' });
    expect(byName(result, 'آغازین')).toMatchObject({ kind: 'function', isExported: true });
  });

  it('reads the renamed Persian keyword set, including repeat with step and index', () => {
    const source = `// زبان: فارسی
همگانی روال جمع(الف: صحیح, ب: صحیح): صحیح:
    ناپایا مجموع := 0
    تکرار 1 تا 10 هر 2 از i:
        مجموع = مجموع + i
    پایان
    برگشت مجموع + الف + ب
پایان

جداشمار رنگ: قرمز, سبز پایان
`;
    const ex = new SalamExtractor('jam.salam', source);
    const result = ex.extract();
    expect(ex.syntaxErrorMessages).toEqual([]);
    expect(ex.keywordLanguage).toBe('fa2');
    expect(byName(result, 'جمع')).toMatchObject({ kind: 'function', returnType: 'صحیح' });
    expect(byName(result, 'رنگ')).toMatchObject({ kind: 'enum' });
    expect(result.nodes.filter((n) => n.kind === 'enum_member')).toHaveLength(2);
  });

  it('keeps a word that is reserved only in the renamed set usable as a name in the released set', () => {
    const source = `// زبان: فارسی
گذرا ورودی := 1

کارکرد آغازین:
    چاپ ورودی
پایان
`;
    const ex = new SalamExtractor('collision.salam', source);
    const result = ex.extract();
    expect(ex.syntaxErrorMessages).toEqual([]);
    expect(ex.keywordLanguage).toBe('fa');
    expect(byName(result, 'ورودی')).toMatchObject({ kind: 'variable' });
  });

  it('keeps the source spelling of a keyword used inside a member name', () => {
    const source = `// زبان: فارسی
فراخوانی دام

کارکرد آغازین:
    دام.با شناسه("a")
پایان
`;
    const result = extract('dom.salam', source);
    expect(refs(result, 'calls')).toContain('دام::با شناسه');
  });
});

describe('Salam layout DSL', () => {
  const source = `func on_click():
    println "clicked"
end

component Card(title = "Hi"):
    heading: content = title end
    button: onclick = on_click() content = "Go" end
    Badge: end
end

layout:
    title = "Page"
    box:
        Card: end
    end
end
`;

  it('extracts components and layouts and links handlers and nested components', () => {
    const ex = new SalamExtractor('page.salam', source);
    const result = ex.extract();
    expect(ex.syntaxErrorMessages).toEqual([]);
    expect(byName(result, 'Card')).toMatchObject({ kind: 'component' });
    expect(byName(result, 'layout')).toMatchObject({ kind: 'component' });
    expect(refs(result, 'calls')).toContain('on_click');
    const instantiated = refs(result, 'instantiates');
    expect(instantiated).toContain('Badge');
    expect(instantiated).toContain('Card');
    expect(instantiated).not.toContain('button');
    expect(instantiated).not.toContain('box');
  });

  it('ends a layout block at its own end, not at the first nested one', () => {
    const result = extract('page.salam', source + '\nfunc after():\n    ret\nend\n');
    expect(byName(result, 'after')).toMatchObject({ kind: 'function' });
    const layout = byName(result, 'layout');
    expect(layout.endLine).toBeLessThan(byName(result, 'after').startLine);
  });
});

describe('Salam error recovery', () => {
  it('keeps the declarations around a syntax error', () => {
    const source = `func good_one(): int:
    ret 1
end

func broken(: :
    x := := 2
end

func good_two(): int:
    ret 2
end
`;
    const result = extract('broken.salam', source);
    expect(result.nodes.map((n) => n.name)).toContain('good_one');
    expect(result.nodes.map((n) => n.name)).toContain('good_two');
    expect(result.errors.filter((e) => e.severity === 'error')).toEqual([]);
  });

  it('never throws on empty or binary-looking input', () => {
    expect(() => extract('empty.salam', '')).not.toThrow();
    expect(() => extract('junk.salam', '\u0000\u0001 ))) ::: end end end }{ "unterminated')).not.toThrow();
  });
});
