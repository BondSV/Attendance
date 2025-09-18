Render deployment guide (simple)

1) Create a Git repository and push your project to a remote (GitHub/GitLab).

2) Sign in to https://render.com and create a new Web Service.

3) Connect your repository, select the branch to deploy (e.g. main).

4) Build & Start commands:
   - Build command: leave empty (no build step)
   - Start command: `npm start`

5) Environment variables (set in Render dashboard):
   - `PORT` (optional, Render sets this automatically)
   - `CSV_DIR` (optional, set to `/tmp/data` or a writable path)
   - `ALLOW_CORS_ALL` (set to `1` for quick testing across origins; unset for same-origin)
   - `ANOMALY_LOG_PATH` (optional path to a file under `/tmp`)

6) File storage: Render's filesystem is ephemeral; for persistent CSVs map to an external file store or S3 in production. For testing, `CSV_DIR=/tmp/data` is fine.

7) After deployment, open the service URL and load `https://<your-service>/.well-known/health` or `/health` to verify.

8) To test with `teacher.html`, open the teacher page at `https://<your-service>/teacher.html` (or download locally and point Student App Origin to the rendered service URL).


