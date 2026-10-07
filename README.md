# cardano-account-custody-fee-sponsor

Cardano fee sponsor service for the account custody model.

## Running

Requires Node 22.

1. Copy `.env.example` to `.env` and fill in every variable:
   - `BLOCKFROST_PREPROD_PROJECT_ID`
   - `SPONSOR_MNEMONIC`
   - `ACCOUNT_SCRIPT_HASH`
   - `ADMIN_API_KEY`
   - `PORT`
   - `DATABASE_PATH`
2. Install dependencies: `npm install`
3. Start the service: `npm run dev`

`GET /health` answers once the service is up.

## Commands

- `npm test` runs the test suite.
- `npm run lint` runs eslint.
- `npm run typecheck` runs the TypeScript compiler with no output.
- `npm run start` runs the service without the file watcher.
- `npm run replenish` splits the sponsor wallet into the pool of fee and collateral UTxOs.
