// Script standalone de migração — ver MIGRATION.md (Etapa 3.5).
// Colunas deixam de pertencer a um projeto (campo "projectId" + "order"
// próprio) e passam a ser compartilhadas pelo workspace inteiro. Cada
// projeto passa a guardar, em "visibleColumnIds", quais colunas exibe e em
// que ordem (a posição no array é a ordem de exibição).
//
// Uso:
//   node migrate-columns.js

import { readFileSync } from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const serviceAccount = JSON.parse(
  readFileSync(new URL("./serviceAccount.json", import.meta.url))
);

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const counts = { workspaces: 0, projects: 0, columns: 0 };

function log(msg) {
  console.log(msg);
}

async function migrateProject(wsId, projectDoc) {
  const projectId = projectDoc.id;

  const columnsSnap = await db
    .collection("workspaces").doc(wsId).collection("columns")
    .where("projectId", "==", projectId)
    .get();

  const columns = columnsSnap.docs
    .map(d => ({ id: d.id, order: d.data().order ?? 0 }))
    .sort((a, b) => a.order - b.order);

  const visibleColumnIds = columns.map(c => c.id);

  await projectDoc.ref.update({ visibleColumnIds });
  log(`  projeto ${projectId} → visibleColumnIds: [${visibleColumnIds.join(", ") || "vazio"}]`);
  counts.projects++;

  for (const col of columns) {
    await db.collection("workspaces").doc(wsId).collection("columns").doc(col.id).update({
      projectId: FieldValue.delete(),
      order: FieldValue.delete(),
    });
    log(`    coluna ${col.id}: removidos projectId/order`);
    counts.columns++;
  }
}

async function migrate() {
  const workspacesSnap = await db.collection("workspaces").get();
  console.log(`Encontrados ${workspacesSnap.size} workspace(s).\n`);

  for (const wsDoc of workspacesSnap.docs) {
    log(`workspace ${wsDoc.id}:`);
    counts.workspaces++;

    const projectsSnap = await db.collection("workspaces").doc(wsDoc.id).collection("projects").get();
    for (const projectDoc of projectsSnap.docs) {
      await migrateProject(wsDoc.id, projectDoc);
    }
  }

  console.log("\n--- Migração concluída ---");
  for (const [k, n] of Object.entries(counts)) {
    console.log(`${k}: ${n}`);
  }
}

migrate().catch((err) => {
  console.error("Erro na migração:", err);
  process.exit(1);
});
