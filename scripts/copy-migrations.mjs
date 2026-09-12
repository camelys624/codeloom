import { cp, mkdir } from 'node:fs/promises';

const destination = new URL(
  '../apps/web/dist/server/db/migrations/',
  import.meta.url,
);
await mkdir(destination, { recursive: true });
await cp(
  new URL('../apps/web/server/db/migrations/', import.meta.url),
  destination,
  {
    recursive: true,
  },
);
