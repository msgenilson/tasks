// Script standalone de migração — ver MIGRATION.md (Etapa 1).
// Lê o schema atual (users/{uid}/workspaces/...) e reescreve no schema alvo
// (workspaces/{workspaceId}/...) usando o Admin SDK. Não apaga nada.
//
// Uso:
//   npm install
//   node migrate.js

import { readFileSync } from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const serviceAccount = JSON.parse(
  readFileSync(new URL("./serviceAccount.json", import.meta.url))
);

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const counts = {
  workspaces: 0,
  members: 0,
  projects: 0,
  tags: 0,
  columns: 0,
  tasks: 0,
  subtasks: 0,
};

function log(from, to) {
  console.log(`${from}  →  ${to}`);
}

async function migrateTask(wsRef, workspaceId, projectId, columnId, taskDoc) {
  const task = taskDoc.data();
  const taskId = taskDoc.id;

  await wsRef.collection("tasks").doc(taskId).set({
    title: task.title ?? "",
    description: task.description ?? "",
    order: task.order ?? Date.now(),
    priority: task.priority ?? null,
    subtaskCount: task.subtaskCount ?? 0,
    subtaskDone: task.subtaskDone ?? 0,
    // renomeação: "tags" (schema atual) → "tagIds" (schema alvo). Copia o
    // valor existente — nunca sobrescrever com array vazio.
    tagIds: task.tags ?? [],
    projectId,
    columnId,
    workspaceId,
  });
  log(
    `.../columns/${columnId}/tasks/${taskId}`,
    `workspaces/${workspaceId}/tasks/${taskId}`
  );
  counts.tasks++;

  const subtasksSnap = await taskDoc.ref.collection("subtasks").get();
  for (const subDoc of subtasksSnap.docs) {
    const sub = subDoc.data();
    const subtaskId = subDoc.id;
    await wsRef.collection("subtasks").doc(subtaskId).set({
      title: sub.title ?? "",
      done: sub.done ?? false,
      order: sub.order ?? 0,
      taskId,
      workspaceId,
    });
    log(
      `.../tasks/${taskId}/subtasks/${subtaskId}`,
      `workspaces/${workspaceId}/subtasks/${subtaskId}`
    );
    counts.subtasks++;
  }
}

async function migrateColumn(wsRef, workspaceId, projectId, colDoc) {
  const col = colDoc.data();
  const columnId = colDoc.id;

  await wsRef.collection("columns").doc(columnId).set({
    name: col.name ?? "",
    order: col.order ?? 0,
    projectId,
    workspaceId,
  });
  log(
    `.../projects/${projectId}/columns/${columnId}`,
    `workspaces/${workspaceId}/columns/${columnId}`
  );
  counts.columns++;

  const tasksSnap = await colDoc.ref.collection("tasks").get();
  for (const taskDoc of tasksSnap.docs) {
    await migrateTask(wsRef, workspaceId, projectId, columnId, taskDoc);
  }
}

async function migrateProject(wsRef, workspaceId, projDoc) {
  const proj = projDoc.data();
  const projectId = projDoc.id;

  await wsRef.collection("projects").doc(projectId).set({
    name: proj.name ?? "",
    order: proj.order ?? 0,
    workspaceId,
    createdAt: FieldValue.serverTimestamp(),
  });
  log(
    `.../workspaces/${workspaceId}/projects/${projectId} (schema antigo)`,
    `workspaces/${workspaceId}/projects/${projectId}`
  );
  counts.projects++;

  const tagsSnap = await projDoc.ref.collection("tags").get();
  for (const tagDoc of tagsSnap.docs) {
    const tag = tagDoc.data();
    const tagId = tagDoc.id;
    await wsRef.collection("tags").doc(tagId).set({
      name: tag.name ?? "",
      color: tag.color ?? "",
      createdAt: tag.createdAt ?? FieldValue.serverTimestamp(),
      projectId,
      workspaceId,
    });
    log(
      `.../projects/${projectId}/tags/${tagId}`,
      `workspaces/${workspaceId}/tags/${tagId}`
    );
    counts.tags++;
  }

  const columnsSnap = await projDoc.ref.collection("columns").get();
  for (const colDoc of columnsSnap.docs) {
    await migrateColumn(wsRef, workspaceId, projectId, colDoc);
  }
}

async function migrateWorkspace(uid, wsDoc) {
  const ws = wsDoc.data();
  const workspaceId = wsDoc.id;
  const wsRef = db.collection("workspaces").doc(workspaceId);

  await wsRef.set({
    name: ws.name ?? "",
    color: ws.color ?? "",
    order: ws.order ?? Date.now(),
    ownerUid: uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  log(
    `users/${uid}/workspaces/${workspaceId}`,
    `workspaces/${workspaceId}`
  );
  counts.workspaces++;

  // necessário mesmo sem feature de convite: as regras da Etapa 2 dependem
  // deste doc, e o campo "uid" é o que permite a collection-group query
  // (Etapa 3) encontrar os workspaces do usuário.
  await wsRef.collection("members").doc(uid).set({
    uid,
    role: "owner",
    joinedAt: FieldValue.serverTimestamp(),
  });
  log(`(novo)`, `workspaces/${workspaceId}/members/${uid}`);
  counts.members++;

  const projectsSnap = await wsDoc.ref.collection("projects").get();
  for (const projDoc of projectsSnap.docs) {
    await migrateProject(wsRef, workspaceId, projDoc);
  }
}

async function migrate() {
  // "users/{uid}" nunca é criado como documento explícito no schema atual
  // (só as subcoleções "profile" e "workspaces" recebem escrita) — por
  // isso db.collection("users").get() retorna vazio mesmo com dados reais
  // por baixo. Uma collection-group query em "workspaces" encontra os
  // documentos independentemente do doc pai existir ou não, e o uid é
  // derivado do path (users/{uid}/workspaces/{workspaceId}).
  const workspacesSnap = await db.collectionGroup("workspaces").get();

  // A partir da segunda execução, já existe uma coleção top-level
  // "workspaces" (o destino da migração) — collectionGroup("workspaces")
  // também bate com ela. Filtramos para pegar só as aninhadas sob
  // "users/{uid}/workspaces", que têm um doc avô (o user).
  const oldSchemaDocs = workspacesSnap.docs.filter(d => d.ref.parent.parent !== null);
  console.log(`Encontrados ${oldSchemaDocs.length} workspace(s) no schema antigo.\n`);

  for (const wsDoc of oldSchemaDocs) {
    const uid = wsDoc.ref.parent.parent.id;
    await migrateWorkspace(uid, wsDoc);
  }

  console.log("\n--- Migração concluída ---");
  for (const [collectionName, n] of Object.entries(counts)) {
    console.log(`${collectionName}: ${n}`);
  }
  console.log(
    "\nNada foi apagado do schema antigo. Confirme os dados no Firebase Console antes de avançar para a Etapa 2."
  );
}

migrate().catch((err) => {
  console.error("Erro na migração:", err);
  process.exit(1);
});
