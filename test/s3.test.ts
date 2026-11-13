// SPDX-License-Identifier: MIT
// SigV4 presign tests. The canonical URI must be RFC-3986 percent-encoded, including the
// sub-delimiters !'()* that encodeURIComponent leaves alone — otherwise the signature
// mismatches on real-world keys (e.g. an apostrophe), which R2/S3 reject with 403. This is
// the bug found in live testing: "…06 L'Aberek.flac" failed its range GET.

import { describe, it, expect } from "vitest";
import { presignGetUrl, type S3Config } from "../src/shared/s3";

const cfg: S3Config = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "music",
  accessKey: "AKEXAMPLE",
  secretKey: "secret-example",
};

describe("presignGetUrl key encoding (SigV4 / RFC 3986)", () => {
  it("percent-encodes sub-delimiters !'()* that encodeURIComponent misses", async () => {
    const url = await presignGetUrl(cfg, "A/L'Aberek (v)!.flac");
    // ' -> %27, space -> %20, ( -> %28, ) -> %29, ! -> %21
    expect(url).toContain("/music/A/L%27Aberek%20%28v%29%21.flac");
    expect(url).not.toContain("L'Aberek"); // the raw apostrophe must not leak into the path
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  it("preserves '/' as a path separator (encodes per segment)", async () => {
    const url = await presignGetUrl(cfg, "artist/album/01 track.flac");
    expect(url).toContain("/music/artist/album/01%20track.flac");
  });

  it("encodes an asterisk and leaves unreserved chars alone", async () => {
    const url = await presignGetUrl(cfg, "a*b/c-d_e.f~g.flac");
    expect(url).toContain("/music/a%2Ab/c-d_e.f~g.flac"); // * -> %2A; - _ . ~ unreserved
  });
});
