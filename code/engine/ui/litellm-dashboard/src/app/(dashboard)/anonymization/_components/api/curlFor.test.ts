import { describe, expect, it } from "vitest";

import { ENDPOINTS } from "./catalogue";
import { curlFor } from "./curlFor";

const encode = ENDPOINTS.find((e) => e.id === "encode")!;
const permissions = ENDPOINTS.find((e) => e.id === "permissions")!;
const revoke = ENDPOINTS.find((e) => e.id === "session-delete")!;

describe("curlFor", () => {
  it("never prints the credential, since the console holds a real one", () => {
    const command = curlFor(encode, "http://localhost:4000/pii/encode", '{"texts":["x"]}');
    expect(command).toContain('Bearer $KEY');
    expect(command).not.toContain("sk-");
  });

  it("carries the method so a DELETE does not paste back as a GET", () => {
    expect(curlFor(revoke, "http://localhost:4000/pii/session/abc", null)).toContain("-X DELETE");
  });

  it("omits the body and its content type when the endpoint takes none", () => {
    const command = curlFor(permissions, "http://localhost:4000/pii/permissions", null);
    expect(command).not.toContain("-d ");
    expect(command).not.toContain("Content-Type");
  });

  it("flattens the pretty-printed body onto one line", () => {
    const command = curlFor(encode, "http://localhost:4000/pii/encode", '{\n  "texts": [\n    "x"\n  ]\n}');
    expect(command).toContain(`-d '{ "texts": [ "x" ] }'`);
  });
});
