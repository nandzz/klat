import { describe, expect, it } from "vitest";
import { cleanForSpeech, splitSentences } from "../src/main/text.js";

const speak = (input: string) => splitSentences(cleanForSpeech(input));

describe("cleanForSpeech", () => {
  it("keeps plain text unchanged", () => {
    expect(cleanForSpeech("I fixed the bug and added two tests.")).toBe("I fixed the bug and added two tests.");
  });

  it("removes fenced code blocks", () => {
    expect(cleanForSpeech("Here it is.\n```ts\nconst a = 1;\n```\nDone.")).toBe("Here it is.\nDone.");
  });

  it("keeps short inline words and commands", () => {
    expect(cleanForSpeech("Run `npm test` now.")).toBe("Run N P M test now.");
  });

  it("names inline code that looks like code", () => {
    expect(cleanForSpeech("Call `queue.speak({ text })` first.")).toBe("Call the code first.");
  });

  it("names inline paths and file names", () => {
    expect(cleanForSpeech("Look at `src/main/main.ts`.")).toBe("Look at the file.");
    expect(cleanForSpeech("Edit `package.json` too.")).toBe("Edit the file too.");
  });

  it("names inline links", () => {
    expect(cleanForSpeech("See `https://example.com/a`.")).toBe("See the link.");
  });

  it("replaces bare links", () => {
    expect(cleanForSpeech("Open https://github.com/a/b/pull/3 to review.")).toBe("Open the link to review.");
  });

  it("keeps the text of Markdown links and images", () => {
    expect(cleanForSpeech("Read [the guide](https://x.dev/guide) and ![the chart](chart.png).")).toBe(
      "Read the guide and the chart.",
    );
  });

  it("replaces absolute, home and relative paths", () => {
    expect(cleanForSpeech("Check /Users/me/app/index.ts now.")).toBe("Check the file now.");
    expect(cleanForSpeech("Check ~/notes/a/b.md now.")).toBe("Check the file now.");
    expect(cleanForSpeech("Check ../x/y/z now.")).toBe("Check the file now.");
    expect(cleanForSpeech("Check src/main/text.ts now.")).toBe("Check the file now.");
  });

  it("does not eat the sentence period after a path", () => {
    expect(speak("Look at src/main/text.ts. Then rest.")).toEqual(["Look at the file.", "Then rest."]);
  });

  it("replaces file names with dots and line numbers", () => {
    expect(cleanForSpeech("The bug is in auth.service.ts:42 today.")).toBe("The bug is in the file today.");
  });

  it("does not treat a single slash as a path", () => {
    expect(cleanForSpeech("Use and/or the client-side flow.")).toBe("Use and/or the client-side flow.");
  });

  it("joins repeated file references", () => {
    expect(cleanForSpeech("I changed a.ts, b.ts and c.ts.")).toBe("I changed the files.");
    expect(cleanForSpeech("I changed a.ts and b.ts.")).toBe("I changed the files.");
  });

  it("removes Markdown structure", () => {
    const input = "## Summary\n> note\n- first item\n* second item\n1. third item\n| a | b |";
    expect(cleanForSpeech(input)).toBe("Summary\nnote\nfirst item\nsecond item\nthird item\na b");
  });

  it("removes emphasis but keeps snake_case words readable", () => {
    expect(cleanForSpeech("This is **bold**, *italic*, __strong__ and ~~old~~.")).toBe(
      "This is bold, italic, strong and old.",
    );
    expect(cleanForSpeech("Rename user_id now.")).toBe("Rename user id now.");
  });

  it("removes HTML tags", () => {
    expect(cleanForSpeech("Line one<br/>line <b>two</b>.")).toBe("Line one line two .");
  });

  it("speaks symbols and abbreviations", () => {
    expect(cleanForSpeech("Tests & lint pass at 100%.")).toBe("Tests and lint pass at 100 percent.");
    expect(cleanForSpeech("Go a -> b, e.g. later, i.e. soon.")).toBe("Go a to b, for example, later, that is, soon.");
    expect(cleanForSpeech("The PR, CI, API, UI and MCP are fine.")).toBe("The P R, C I, A P I, U I and M C P are fine.");
    expect(cleanForSpeech("Edit the JSON and SQL.")).toBe("Edit the Jason and sequel.");
  });

  it("returns an empty string for only code", () => {
    expect(cleanForSpeech("```\nrm -rf /tmp/x\n```")).toBe("");
  });

  it("collapses spaces and trims", () => {
    expect(cleanForSpeech("  a   lot\t of   space  ")).toBe("a lot of space");
  });
});

describe("splitSentences", () => {
  it("returns no sentences for empty text", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("  \n  ")).toEqual([]);
  });

  it("splits on sentence ends", () => {
    expect(splitSentences("The first one. The second one! The third one?")).toEqual([
      "The first one.",
      "The second one!",
      "The third one?",
    ]);
  });

  it("keeps a final sentence without punctuation", () => {
    expect(splitSentences("Done. Look at the summary")).toEqual(["Done.", "Look at the summary"]);
  });

  it("splits on new lines", () => {
    expect(splitSentences("First line\nSecond line")).toEqual(["First line", "Second line"]);
  });

  it("keeps a short first sentence alone for fast first audio", () => {
    expect(splitSentences("Done. I fixed the login bug. All tests pass now.")).toEqual([
      "Done.",
      "I fixed the login bug.",
      "All tests pass now.",
    ]);
  });

  it("merges a short sentence after the first into the next one", () => {
    expect(splitSentences("First sentence here. Yes. Then more text.")).toEqual([
      "First sentence here.",
      "Yes. Then more text.",
    ]);
  });

  it("splits very long sentences on commas", () => {
    const clause = "this is a clause that keeps going for a while";
    const long = Array.from({ length: 8 }, () => clause).join(", ") + ".";
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(220);
    expect(parts.join(" ")).toBe(long);
  });
});
