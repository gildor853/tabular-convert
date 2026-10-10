import { describe, expect, it } from "vitest";
import { readSql, writeSql } from "../src/index.js";
import { quoteIdent, quoteString, sqlLiteral } from "../src/formats/sql.js";
import { names, table, throwsCode } from "./helpers/index.js";

const t = table(["id", "name", "ok", "when", "at", "price", "big"], [
  [1, "O'Brien", true, new Date(Date.UTC(2026, 9, 9)), new Date(Date.UTC(2026, 9, 9, 12, 30, 0, 250)), 1.5, 2n ** 70n],
  [2, null, false, null, null, -0, -5n],
]);

describe("SQL escaping per dialect", () => {
  it("quotes identifiers", () => {
    expect(quoteIdent('we"ird', "postgres")).toBe('"we""ird"');
    expect(quoteIdent('we"ird', "sqlite")).toBe('"we""ird"');
    expect(quoteIdent("we`ird", "mysql")).toBe("`we``ird`");
    expect(quoteIdent("we]ird[", "mssql")).toBe("[we]]ird[]");
    throwsCode(() => quoteIdent("a\0b", "postgres"), "InvalidInput", /NUL/);
    throwsCode(() => quoteIdent("", "postgres"), "InvalidInput");
  });

  it("escapes strings", () => {
    const s = "it's a \\ test";
    expect(quoteString(s, "postgres")).toBe("'it''s a \\ test'");
    expect(quoteString(s, "sqlite")).toBe("'it''s a \\ test'");
    expect(quoteString(s, "mssql")).toBe("N'it''s a \\ test'");
    expect(quoteString(s, "mysql")).toBe("'it''s a \\\\ test'");
    expect(quoteString("a\0b\x1a", "mysql")).toBe("'a\\0b\\Z'");
    expect(quoteString("multi\nline", "postgres")).toBe("'multi\nline'");
    for (const d of ["postgres", "sqlite", "mssql"] as const) throwsCode(() => quoteString("a\0", d), "InvalidInput", /NUL/);
  });

  it("writes literals", () => {
    expect(sqlLiteral(true, "postgres")).toBe("TRUE");
    expect(sqlLiteral(false, "mysql")).toBe("FALSE");
    expect(sqlLiteral(true, "sqlite")).toBe("1");
    expect(sqlLiteral(false, "mssql")).toBe("0");
    expect(sqlLiteral(null, "mssql")).toBe("NULL");
    expect(sqlLiteral(-0, "postgres")).toBe("0");
    expect(sqlLiteral(1e21, "postgres")).toBe("1e+21");
    expect(sqlLiteral(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), "postgres")).toBe("'2026-01-02 03:04:05'");
    throwsCode(() => sqlLiteral(Number.NaN, "postgres"), "InvalidInput");
    throwsCode(() => sqlLiteral(new Date(Date.UTC(10000, 0, 1)), "postgres"), "InvalidInput", /years/);
  });
});

describe("writeSql", () => {
  it("writes postgres CREATE TABLE + INSERT", () => {
    expect(writeSql(t, { createTable: true, tableName: "orders", schema: "shop" })).toBe(
      `CREATE TABLE "shop"."orders" (
  "id" BIGINT,
  "name" TEXT,
  "ok" BOOLEAN,
  "when" DATE,
  "at" TIMESTAMP(3),
  "price" DOUBLE PRECISION,
  "big" NUMERIC
);
INSERT INTO "shop"."orders" ("id", "name", "ok", "when", "at", "price", "big") VALUES
  (1, 'O''Brien', TRUE, '2026-10-09', '2026-10-09 12:30:00.250', 1.5, 1180591620717411303424),
  (2, NULL, FALSE, NULL, NULL, 0, -5);
`,
    );
  });

  it("writes the other dialects", () => {
    expect(writeSql(t, { dialect: "mysql", createTable: true })).toContain("CREATE TABLE `data` (\n  `id` BIGINT,\n  `name` LONGTEXT,\n  `ok` BOOLEAN,\n  `when` DATE,\n  `at` DATETIME(3),\n  `price` DOUBLE,\n  `big` DECIMAL(65,0)\n);");
    expect(writeSql(t, { dialect: "sqlite", createTable: true })).toContain('"ok" INTEGER,\n  "when" TEXT,\n  "at" TEXT,\n  "price" REAL,\n  "big" NUMERIC');
    const ms = writeSql(t, { dialect: "mssql", createTable: true });
    expect(ms).toContain("[name] NVARCHAR(MAX),\n  [ok] BIT,\n  [when] DATE,\n  [at] DATETIME2(3),\n  [price] FLOAT,\n  [big] DECIMAL(38,0)");
    expect(ms).toContain("(1, N'O''Brien', 1, N'2026-10-09', N'2026-10-09 12:30:00.250', 1.5, 1180591620717411303424)");
  });

  it("batches INSERTs", () => {
    const many = table(["n"], Array.from({ length: 5 }, (_, i) => [i]));
    const out = writeSql(many, { batchSize: 2 });
    expect(out.match(/INSERT INTO/g)?.length).toBe(3);
    throwsCode(() => writeSql(many, { dialect: "mssql", batchSize: 1001 }), "InvalidOption");
    expect(writeSql(table(["a"], []), { createTable: true })).toBe('CREATE TABLE "data" (\n  "a" TEXT\n);\n');
    expect(writeSql(table(["a"], []))).toBe("");
  });

  it("guesses integer, wide integer, mixed and empty column types", () => {
    const x = table(["i", "w", "m", "e"], [[1, 2n ** 40n, "a", null], [2n, 3, 1, null]]);
    expect(writeSql(x, { createTable: true })).toContain('"i" BIGINT,\n  "w" BIGINT,\n  "m" TEXT,\n  "e" TEXT');
  });

  it("validates input and options", () => {
    throwsCode(() => writeSql({ columns: [], rows: [] }), "InvalidInput", /without columns/);
    throwsCode(() => writeSql(t, { dialect: "oracle" as "mysql" }), "InvalidOption");
    throwsCode(() => writeSql(t, { tableName: 5 as unknown as string }), "InvalidOption");
    throwsCode(() => writeSql(t, { schema: 5 as unknown as string }), "InvalidOption");
  });
});

describe("readSql", () => {
  it("reads INSERT … VALUES with column lists", () => {
    const r = readSql(`-- dump
CREATE TABLE "t" ("a" int, "b" text);
/* block
   comment */
INSERT INTO "t" ("a", "b") VALUES (1, 'it''s'), (-2.5, NULL);
insert into t (b, a) values ('x', +3);`);
    expect(names(r)).toEqual(["a", "b"]);
    expect(r.rows).toEqual([
      [1, "it's"],
      [-2.5, null],
      [3, "x"],
    ]);
  });

  it("takes column names from CREATE TABLE when INSERTs have no column list", () => {
    const r = readSql("CREATE TABLE IF NOT EXISTS `t` (`id` INT NOT NULL, `name` VARCHAR(10) DEFAULT 'a,b', PRIMARY KEY (`id`), KEY `k` (`name`)); INSERT INTO `t` VALUES (1,'a\\'b'),(2,'c\\\\d');");
    expect(names(r)).toEqual(["id", "name"]);
    expect(r.rows).toEqual([
      [1, "a'b"],
      [2, "c\\d"],
    ]);
  });

  it("names columns when nothing is known", () => {
    expect(readSql("INSERT INTO t VALUES (1, TRUE, FALSE, DEFAULT)")).toEqual(table(["column_1", "column_2", "column_3", "column_4"], [[1, true, false, null]]));
  });

  it("round-trips every dialect", () => {
    const tricky = table(["id", "text", "flag"], [
      [1, "O'Brien \\ \"q\" ; -- not a comment", true],
      [2, "multi\nline /* x */", false],
      [9007199254740993n, "žluťoučký 😀", null],
    ]);
    for (const dialect of ["postgres", "mysql", "sqlite", "mssql"] as const) {
      const sql = writeSql(tricky, { dialect, createTable: true, batchSize: 2 });
      const back = readSql(sql, { dialect });
      const expected = tricky.rows.map((r) => (dialect === "sqlite" || dialect === "mssql" ? r.map((c) => (typeof c === "boolean" ? (c ? 1 : 0) : c)) : r));
      expect(names(back)).toEqual(["id", "text", "flag"]);
      expect(back.rows).toEqual(expected);
    }
  });

  it("handles N'', E'' and dollar-quoted strings and skips other statements", () => {
    const r = readSql(`SET NAMES utf8;
CREATE FUNCTION f() RETURNS int AS $$ BEGIN INSERT INTO x VALUES (1); END $$ LANGUAGE plpgsql;
INSERT INTO t (a, b, c) VALUES (N'ň', E'tab\\there', $tag$raw ' text$tag$) ON CONFLICT DO NOTHING;
COMMIT;`);
    expect(r.rows).toEqual([["ň", "tab\there", "raw ' text"]]);
  });

  it("chooses a table when there are several", () => {
    const sql = "INSERT INTO a (x) VALUES (1); INSERT INTO b (y) VALUES (2);";
    throwsCode(() => readSql(sql), "InvalidOption", /several tables/);
    expect(readSql(sql, { table: "B" }).rows).toEqual([[2]]);
    throwsCode(() => readSql(sql, { table: "c" }), "InvalidOption", /No INSERTs/);
    expect(readSql("INSERT INTO s.t (x) VALUES (1)", { table: "t" }).rows).toEqual([[1]]);
  });

  it("merges INSERTs with different column lists", () => {
    const r = readSql("INSERT INTO t (a) VALUES (1); INSERT INTO t (b, a) VALUES (2, 3);");
    expect(r).toEqual(table(["a", "b"], [[1, null], [3, 2]]));
  });

  it("never executes anything and rejects non-literal values", () => {
    throwsCode(() => readSql("INSERT INTO t VALUES (now())"), "UnsupportedFormat", /literal/);
    throwsCode(() => readSql("INSERT INTO t SELECT * FROM u"), "UnsupportedFormat", /VALUES/);
    throwsCode(() => readSql("INSERT INTO t VALUES (X'00')"), "UnsupportedFormat", /Hex/);
    throwsCode(() => readSql("DROP TABLE users;"), "ParseError", /No INSERT/);
  });

  it("reports malformed statements", () => {
    throwsCode(() => readSql("INSERT INTO t VALUES (1, 'open"), "ParseError", /Unterminated/);
    throwsCode(() => readSql("INSERT INTO t (a, b) VALUES (1)"), "ParseError", /column list has 2/);
    throwsCode(() => readSql("INSERT INTO t VALUES (1 2)"), "ParseError", /Expected "," or "\)"/);
    throwsCode(() => readSql("INSERT INTO t VALUES 1"), "ParseError", /to start a row/);
    throwsCode(() => readSql("INSERT INTO (a) VALUES (1)"), "ParseError", /table name/);
    throwsCode(() => readSql("INSERT INTO t (a b) VALUES (1)"), "ParseError", /column list/);
    throwsCode(() => readSql("INSERT INTO t VALUES (-'x')"), "ParseError", /number after a sign/);
    throwsCode(() => readSql("INSERT INTO t VALUES (1e999)"), "ParseError", /out of range/);
    throwsCode(() => readSql("INSERT INTO t VALUES ($$x)"), "ParseError", /dollar/);
    throwsCode(() => readSql("INSERT INTO t (a) VALUES (1); INSERT INTO t VALUES (2);"), "ParseError", /column list and some do not/);
    throwsCode(() => readSql("INSERT INTO t VALUES (1)", { table: 1 as unknown as string }), "InvalidOption");
  });

  it("enforces limits", () => {
    throwsCode(() => readSql("INSERT INTO t VALUES (1),(2),(3)", { limits: { maxRows: 2 } }), "LimitExceeded");
    throwsCode(() => readSql("INSERT INTO t VALUES (1,2,3)", { limits: { maxColumns: 2 } }), "LimitExceeded");
    throwsCode(() => readSql("INSERT INTO t VALUES ('abcdef')", { limits: { maxCellLength: 3 } }), "LimitExceeded");
  });

  it("infers types of strings on request", () => {
    expect(readSql("INSERT INTO t (d) VALUES ('2026-10-09')", { infer: true }).rows).toEqual([[new Date(Date.UTC(2026, 9, 9))]]);
  });
});
