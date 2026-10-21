import { serveDir } from "jsr:@std/http/file-server";

Deno.serve((request) =>
  serveDir(request, {
    fsRoot: "./public",
  })
);
