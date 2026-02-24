import "./src/models/index.js";
import Email from "./src/models/email.model.js";

async function check() {
  const ids = [
    "8a5e04b5-2d90-4d31-95d9-db39a15c3a8e",
    "0e93eb8e-3561-4171-993d-f2395aba3c1f",
    "e49832c2-5ef1-4f35-a03d-2c7ff5ce5ba1"
  ];

  for (const id of ids) {
    const email = await Email.findByPk(id);
    console.log(`Email ${id}: status=${email?.status}, lastError=${email?.lastError}`);
  }
  process.exit(0);
}

check();
