# Stratum

A self-hosted **OpenSubsonic / Subsonic** music server that runs entirely on **Cloudflare
Workers + D1**, streaming audio from any S3-compatible storage you control. Drop-in compatible
with Subsonic clients (Symfonium, Amperfy, DSub, …).

- **Server** (`fetch`): answers the Subsonic API from D1; audio is served by 302-redirecting the
  client to a short-lived presigned URL — the Worker never proxies audio bytes.
- **Importer** (`scheduled`): scans your storage on a cron, reads tags/cover art, and writes the
  library into D1. Resumable, batched, free-tier friendly.
- **Storage**: admin-configured, multiple S3-compatible backends at once (Garage, MinIO, R2, B2,
  AWS S3), each tagged with a role (primary / fast / backup / low-quality).

Status: **v1 in progress.** See [`docs/V1-PLAN.md`](docs/V1-PLAN.md).

## License

MIT
