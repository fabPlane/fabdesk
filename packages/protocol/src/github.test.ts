import { expect, test } from "bun:test";
import { parsePublicGitHubUrl } from "./github";

test("GitHub project name and normalized clone URL come from the same parser", () => {
  for (const suffix of ["", "/", ".git", ".git/"]) {
    expect(parsePublicGitHubUrl(` https://github.com/FabPlane/my-board${suffix} `)).toEqual({
      owner: "FabPlane", repo: "my-board", url: "https://github.com/FabPlane/my-board.git",
    });
  }
  expect(parsePublicGitHubUrl("https://github.com/a/board.v2").repo).toBe("board.v2");
  for (const url of ["https://github.com/-bad/repo", "https://github.com/a/.hidden", "https://user@github.com/a/repo", "https://github.com/a/repo/tree/main", "https://example.com/a/repo", "https://github.com/a/repo?q=1", "http://github.com/a/repo"]) {
    expect(() => parsePublicGitHubUrl(url)).toThrow();
  }
});
