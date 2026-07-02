# MIGRATION.md — Migração de Schema + Novas Features

## Contexto

App Kanban em produção com dados reais no Firebase Firestore.
Este documento orienta a migração do schema atual para um schema flat,
habilitando visão global de tasks e preparando o terreno para múltiplos
usuários por workspace no futuro.

Este documento foi revisado com base no código atual do app (`public/*.js`),
não apenas na especificação original — os campos, paths e funções citados
abaixo batem com o que existe hoje.

Executar uma etapa por vez. Não avançar sem a etapa anterior funcionando.

**Decisões já tomadas nesta revisão (marcadas com 🔧 onde relevante):**

- Descoberta de workspaces do usuário passa a ser via **collection-group query**
  em `members`, não via array `users/{uid}.workspaces`. Evita denormalização
  que precisaria ser mantida em sincronia manualmente.
- Tags continuam **por projeto** (ganham campo `projectId`), mantendo o
  comportamento atual — o schema alvo original omitia esse campo, o que
  mudaria tags de "por projeto" para "por workspace" sem isso ser uma decisão
  explícita. Se quiser tags compartilhadas entre projetos do mesmo workspace,
  me avise que ajusto.
- Convite de membros / múltiplos usuários por workspace (antiga Etapa 6) foi
  movido para o **Backlog**, no final deste documento — não é foco agora.
- Dados antigos **não são apagados** até a Etapa 4, e só depois de confirmar
  que o app está 100% funcional no schema novo. Etapas 1–3 coexistem com o
  schema antigo intacto.
- Perfil do usuário (`users/{uid}/profile/data` — nome, email) **não muda**.
  Ele já é um documento isolado e não tem relação com a migração de
  workspaces/projects/tasks — não faz sentido mexer nele aqui.

---

## Schema Atual

```
users/{uid}/
  profile/data
    - name, email

  workspaces/{workspaceId}/
    projects/{projectId}/
      tags/{tagId}
        - name, color, createdAt
      columns/{columnId}/
        tasks/{taskId}/
          - title, description, order, priority, tags (array de tagId),
            subtaskCount, subtaskDone
          subtasks/{subtaskId}
            - title, done, order
```

---

## Schema Alvo

```
users/{uid}/
  profile/data                    ← inalterado, fora do escopo desta migração
    - name, email

workspaces/{workspaceId}/
  - name, color, ownerUid, createdAt

  members/{uid}/
    - uid                          ← duplicado como campo (necessário para
                                     collection-group query, ver Etapa 1)
    - role: "owner" | "member"
    - joinedAt

  projects/{projectId}/
    - name, order, workspaceId, createdAt

  tags/{tagId}/
    - name, color, projectId, workspaceId, createdAt

  columns/{columnId}/
    - name, order, projectId, workspaceId

  tasks/{taskId}/
    - title, description, order, priority
    - projectId, columnId, workspaceId
    - tagIds: [tagId]              ← renomeado de "tags" (não recriado vazio,
                                      ver Etapa 1)
    - subtaskCount, subtaskDone

  subtasks/{subtaskId}/
    - taskId, title, done, order
    - workspaceId
```

**Princípio:** `projects`, `tags`, `columns`, `tasks` e `subtasks` deixam de
ser aninhados uns dentro dos outros e passam a ser subcoleções diretas de
`workspaces/{workspaceId}`, referenciando o pai via campo (`projectId`,
`columnId`, `taskId`) em vez de path. Queries cross-project e cross-column
passam a ser filtros simples (`where`) dentro da mesma coleção.

`createdAt` não existe nos documentos atuais (`projects`, `columns`,
`workspaces`) — a migração vai preenchê-lo com a data da migração, não a
data de criação original. Isso é uma aproximação aceitável; se precisar da
data real de criação em algum lugar, ela não existe hoje e não há como
recuperá-la.

---

## Etapa 0 — Backup ⏭️ (pulada a pedido — Etapa 1 não apaga nada, risco baixo)

**Objetivo:** Garantir um snapshot restaurável antes de qualquer escrita.

```bash
gcloud firestore export gs://<SEU_BUCKET>/backups/pre-migration-$(date +%Y%m%d) \
  --project=<SEU_PROJECT_ID>
```

- Preencher `<SEU_BUCKET>` com um bucket do Cloud Storage do mesmo projeto
  Firebase (criar um se não existir — o Firestore export exige um bucket).
- Confirmar no Console do Cloud Storage que o export terminou (`DONE`) antes
  de rodar a Etapa 1.
- Alternativa mais simples se não quiser lidar com `gcloud`/buckets agora:
  exportar manualmente pelo Firebase Console → Firestore Database → Backups
  (se o plano do projeto suportar) ou rodar um dump para JSON local com o
  Admin SDK.

---

## Etapa 1 — Script de migração dos dados ✅ Concluída

**Executada.** 4 workspaces, 4 members (owners), 8 projects, 14 tags, 16 columns,
80 tasks, 2 subtasks migrados via `migrate.js`. Schema antigo intacto.
Ajustes feitos durante a execução (não previstos na v1 deste doc):
- A descoberta de `uid`s via `db.collection("users").get()` retornava vazio
  porque `users/{uid}` nunca é criado como documento explícito (só as
  subcoleções recebem escrita) — trocado para `collectionGroup("workspaces")`,
  filtrando as que têm doc avô (schema antigo) das que não têm (a própria
  coleção `workspaces` de destino, que colide no nome).
- Campo `order` dos workspaces também precisa ser copiado (fica faltando na
  v1 deste doc) — sem ele a ordenação da lista de workspaces quebra.

**Objetivo:** Ler o schema atual e reescrever no schema alvo sem apagar nada.

**Script Node.js standalone:**

```
migrate.js            # script de migração
serviceAccount.json   # chave de serviço do Firebase (não commitar — .gitignore)
```

**Lógica do script:**

1. Autenticar com Firebase Admin SDK via `serviceAccount.json`.
2. Percorrer `users/{uid}/workspaces/{workspaceId}` para cada usuário.
3. Criar `workspaces/{workspaceId}` com `name`, `color` (copiados),
   `ownerUid: uid`, `createdAt: FieldValue.serverTimestamp()`.
4. Criar `workspaces/{workspaceId}/members/{uid}` com `uid`, `role: "owner"`,
   `joinedAt: FieldValue.serverTimestamp()`. **Necessário mesmo sem feature de
   convite** — as regras da Etapa 2 dependem desse doc para liberar acesso ao
   dono, e o campo `uid` é o que permite a collection-group query da Etapa 3
   encontrar os workspaces do usuário.
5. Para cada `projects/{projectId}`: copiar **todos os campos existentes**
   (`name`, `order`) para `workspaces/{workspaceId}/projects/{projectId}`,
   adicionando `workspaceId` e `createdAt: serverTimestamp()`.
6. Para cada `tags/{tagId}` (hoje aninhado em `projects/{projectId}/tags`):
   copiar `name`, `color`, `createdAt` (se existir) para
   `workspaces/{workspaceId}/tags/{tagId}`, adicionando `projectId` e
   `workspaceId`.
7. Para cada `columns/{columnId}`: copiar `name`, `order` para
   `workspaces/{workspaceId}/columns/{columnId}`, adicionando `projectId` e
   `workspaceId`.
8. Para cada `tasks/{taskId}`: copiar **todos os campos existentes**
   (`title`, `description`, `order`, `priority`, `subtaskCount`,
   `subtaskDone`) para `workspaces/{workspaceId}/tasks/{taskId}`,
   adicionando `projectId`, `columnId`, `workspaceId`, e
   **`tagIds: task.tags || []`** (renomeação — copiar o valor existente, não
   criar array vazio).
   > ⚠️ Correção sobre a versão anterior deste documento: o campo `tags` já
   > guarda as tagIds atribuídas à task hoje. Escrever `tagIds: []` apagaria
   > essa atribuição. Não fazer isso.
   >
   > Não adicionar campo `assignees` nesta etapa — pertence à feature de
   > convite/múltiplos usuários, que está no backlog.
9. Para cada `subtasks/{subtaskId}`: copiar `title`, `done`, `order` para
   `workspaces/{workspaceId}/subtasks/{subtaskId}`, adicionando `taskId` e
   `workspaceId`.
10. Logar cada documento migrado com path de origem e destino.
11. Ao final, imprimir contagem total por coleção.

**Idempotência:** usar `.set()` com o mesmo ID de documento em todos os
passos (nunca `.add()`), preservando o ID original. Rodar o script duas
vezes reescreve os mesmos documentos em vez de duplicar — mas ainda assim
prefira rodar uma única vez e conferir os logs.

**Não deletar nada nesta etapa.**
Rodar o script e verificar no Firebase Console se os dados apareceram
corretamente no novo schema antes de avançar.

---

## Etapa 2 — Atualizar regras do Firestore ✅ Concluída

**Deployada e validada com 20 casos de teste no emulador do Firestore**
(`@firebase/rules-unit-testing`), incluindo negativos de segurança
(outsider não lê/escreve workspace alheio). Duas correções importantes
sobre a v1 deste doc, ambas confirmadas empiricamente antes do deploy final:

1. **`members` não pode ficar aninhado sob `/workspaces/{workspaceId}`.**
   Uma collection-group query (usada por `workspaces.js:getWorkspaces` para
   descobrir os workspaces do uid logado) só é coberta por regras declaradas
   com o padrão recursivo `match /{path=**}/members/{memberId}` no nível
   raiz — um `match` aninhado nunca casa com queries de collection-group,
   não importa a condição usada.
2. **A leitura do próprio member doc usa `resource.data.uid`, não
   `exists()`/variável de path.** O Firestore só prova a segurança de uma
   query de "list" casando o filtro da query (`where("uid","==",...)`) com
   um campo de `resource.data` — não com `exists()` de outro documento nem
   com uma variável de path, mesmo que ambos apontem pro mesmo valor.
3. **Criar um workspace precisa de `allow create` baseado em
   `request.resource.data.ownerUid`, não em `isMember`.** No momento da
   criação o doc de membership ainda não existe (`isMember` seria sempre
   falso) — e escritas no mesmo `writeBatch`/transação não se enxergam umas
   às outras durante a avaliação de regras, então `createWorkspace` faz duas
   escritas sequenciais reais (não um batch) em vez de uma só.

Ver o `firestore.rules` final para os comentários inline explicando cada regra.

**Objetivo:** Reescrever `firestore.rules` para o novo schema, mantendo as
regras antigas ativas em paralelo.

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // schema antigo — mantido até a Etapa 4
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }

    // schema novo
    function isMember(workspaceId) {
      return request.auth != null &&
        exists(/databases/$(database)/documents/workspaces/$(workspaceId)/members/$(request.auth.uid));
    }

    match /workspaces/{workspaceId} {
      allow read, write: if isMember(workspaceId);

      match /members/{memberId} {
        allow read: if isMember(workspaceId);
        // só o owner cria/remove membros — sem feature de convite ainda,
        // isso na prática só permite o próprio owner se auto-inserir na
        // Etapa 1 (via Admin SDK, que ignora rules) e nada mais por ora
        allow write: if request.auth != null &&
          get(/databases/$(database)/documents/workspaces/$(workspaceId)).data.ownerUid == request.auth.uid;
      }

      match /{subcollection}/{docId} {
        allow read, write: if isMember(workspaceId);
      }
    }
  }
}
```

- `members` exige checagem separada (owner-only para escrita) porque é a
  base do controle de acesso — mesmo sem UI de convite, a regra já fica
  correta para quando essa feature sair do backlog.
- Testar no Rules Playground do Firebase Console com paths do schema alvo
  antes de avançar (ex: simular leitura de `workspaces/abc/tasks/xyz` como
  membro e como não-membro).

**Índice necessário para a Etapa 3:** habilitar collection-group query no
campo `uid` da coleção `members` (Firebase Console → Firestore → Índices →
aba "Grupo de coleções", ou adicionar em `firestore.indexes.json`):

```json
{
  "fieldOverrides": [
    {
      "collectionGroup": "members",
      "fieldPath": "uid",
      "indexes": [{ "order": "ASCENDING", "queryScope": "COLLECTION_GROUP" }]
    }
  ]
}
```

---

## Etapa 3 — Refatorar o app para o novo schema ✅ Concluída

**Testada manualmente de ponta a ponta**: login, criar/selecionar workspace,
projetos, colunas, tasks, drag-and-drop entre colunas, tags e editar/deletar
— tudo funcionando sem erros de console. Um bug de concorrência foi
encontrado e corrigido durante o teste: o listener de `getWorkspaces`
processava o member doc recém-criado ainda como escrita local pendente
(antes do servidor confirmar), e o `getDoc()` do workspace pai — uma
chamada de rede separada — podia chegar no servidor antes da escrita do
member doc realmente commitar lá, fazendo a regra falhar momentaneamente.
Corrigido ignorando docs com `metadata.hasPendingWrites` (o listener
dispara de novo assim que a escrita é confirmada).

**Objetivo:** Atualizar todos os módulos JS para ler e escrever no novo
schema. O app deve continuar funcionando normalmente após esta etapa.

**`firebase.js`:** sem mudanças.

**`workspaces.js`** (reescrita — não estava no plano original e é essencial,
já que é o módulo que muda de path mais drasticamente):

- `getWorkspaces(uid, callback)` — descobrir os workspaces do usuário via
  collection-group query em `members` filtrando `where("uid", "==", uid)`,
  depois buscar cada `workspaces/{id}` correspondente. Manter reatividade
  com `onSnapshot` (não `getDocs` — regra do projeto é sempre `onSnapshot`
  para dados que precisam de reatividade):

  ```js
  import { collectionGroup, query, where, onSnapshot, doc, getDoc } from "...";

  export function getWorkspaces(uid, callback) {
    const q = query(collectionGroup(db, "members"), where("uid", "==", uid));
    return onSnapshot(q, async (snap) => {
      const workspaces = await Promise.all(
        snap.docs.map(async (memberDoc) => {
          const wsRef = memberDoc.ref.parent.parent; // workspaces/{id}
          const wsSnap = await getDoc(wsRef);
          return { id: wsSnap.id, ...wsSnap.data() };
        }),
      );
      callback(workspaces);
    });
  }
  ```

- `createWorkspace(uid, name, color)` — passa a fazer duas escritas: criar
  `workspaces/{novoId}` (`name`, `color`, `ownerUid: uid`,
  `createdAt: serverTimestamp()`) e criar
  `workspaces/{novoId}/members/{uid}` (`uid`, `role: "owner"`,
  `joinedAt: serverTimestamp()`). Usar `writeBatch` para as duas escritas
  serem atômicas.
- `updateWorkspace(uid, workspaceId, data)` — aponta para
  `workspaces/{workspaceId}` diretamente (sem mais `users/{uid}/...`).
- `deleteWorkspace(uid, workspaceId)` — cascade delete de `members`,
  `projects`, `tags`, `columns`, `tasks`, `subtasks`, tudo sob
  `workspaces/{workspaceId}`.
- `initWorkspaces` / `destroyWorkspaces` — mesma responsabilidade de UI,
  só trocam a fonte de dados.

**`tags.js`** (não estava no plano original — precisa mudar de path):

- Paths migrados de `workspaces/{workspaceId}/projects/{projectId}/tags/{tagId}`
  para `workspaces/{workspaceId}/tags/{tagId}` com campo `projectId`.
- `getTags(uid, workspaceId, projectId, callback)` — `onSnapshot` com
  `where("projectId", "==", projectId)`, mesma assinatura de hoje, só muda a
  query interna.
- `createTag`, `deleteTag` atualizados para o novo path.
- Requer índice composto (`projectId` + ordenação, se houver).

**`auth.js`:**

- Sem mudança na lógica de login/logout em si. Após login, não precisa mais
  ler `users/{uid}` para descobrir workspaces (isso saiu do escopo — ver
  nota sobre `users/{uid}` acima) — quem descobre workspaces agora é
  `workspaces.js` via `getWorkspaces`.
- Workspace ativo continua salvo em `localStorage` (`kanban_active_workspace`),
  igual já funciona hoje.

**`projects.js`:**

- Paths migrados para `workspaces/{workspaceId}/projects/{projectId}`.
- `getProjects(workspaceId, callback)` — `onSnapshot` direto na subcoleção
  (não precisa `where`, já está escopado pelo path).
- `createProject`, `updateProject`, `deleteProject` atualizados.

**`board.js`:**

- `getColumns(workspaceId, projectId, callback)` — `onSnapshot` em
  `workspaces/{workspaceId}/columns` com `where("projectId", "==", projectId)`,
  `orderBy("order")`. Requer índice composto.
- `createColumn`, `updateColumn`, `deleteColumn` atualizados.

**`tasks.js`:**

- `getTasks(workspaceId, columnId, callback)` — `onSnapshot` em
  `workspaces/{workspaceId}/tasks` com `where("columnId", "==", columnId)`,
  `orderBy("order")`. Requer índice composto.
- `getAllTasks(workspaceId, callback)` — `onSnapshot` sem filtro de coluna
  (para o painel global da Etapa 5).
- `createTask`, `updateTask`, `deleteTask` atualizados. Campo `tags` passa a
  se chamar `tagIds` em todo o código (drawer, picker de tags no board).
- `moveTask(workspaceId, taskId, newColumnId, newProjectId)` — atualiza
  `columnId`, `projectId` e `order` em um único `update`. Usada pelo drag
  quando o card muda de coluna (e, como colunas pertencem a um projeto,
  mudar de coluna pode implicitamente mudar de projeto — conferir se o
  board hoje permite arrastar cards entre projetos diferentes ou só entre
  colunas do mesmo projeto; se for só mesmo projeto, `newProjectId` nem
  precisa ser parâmetro).
- CRUD de subtarefas migrado para `workspaces/{workspaceId}/subtasks/{subtaskId}`
  com `where("taskId", "==", taskId)`.

**`drag.js`:**

- Atualizar chamadas para `moveTask` no novo path.

Testar fluxo completo: login → selecionar workspace → selecionar projeto →
ver colunas → criar task → arrastar → abrir drawer → editar título/descrição
→ marcar subtarefa → atribuir tag → logout.

---

## Etapa 4 — Deletar dados do schema antigo

**Objetivo:** Remover os dados do schema antigo **só depois** de confirmar
que o app está 100% funcional no novo schema (Etapa 3 testada e estável).

**Script Node.js standalone:**

```
cleanup.js   # script de limpeza
```

1. Autenticar com Firebase Admin SDK.
2. Percorrer `users/{uid}/workspaces/{workspaceId}/...` recursivamente.
3. Deletar todos os documentos e subcoleções do schema antigo em batches de
   500 (limite do Firestore).
4. Logar cada deleção.
5. Ao final, imprimir contagem de documentos deletados.

**Não remover `users/{uid}` nem `users/{uid}/profile`** — só as subcoleções
`workspaces` e abaixo. O perfil do usuário nunca fez parte da migração.

Rodar apenas após confirmar que o app está 100% funcional no novo schema.
Após o cleanup, remover as regras antigas (`match /users/{uid}/{document=**}`)
do `firestore.rules`.

---

## Etapa 5 — Painel global de tasks

**Objetivo:** Nova view mostrando todas as tasks de todos os projetos do
workspace ativo.

**UI:**

- Novo item no navbar: "Todas as tasks" (ou ícone de lista).
- Alterna entre a view kanban normal e a view global.
- View global: lista vertical, agrupada por projeto.
- Cada item exibe: título, projeto (badge colorido), coluna atual, progresso
  de subtarefas.
- Filtros no topo: por projeto, por status de subtarefas (com pendentes,
  todas concluídas).
- Clique no item abre o mesmo drawer lateral da view kanban.

**Implementação:**

- Usar `getAllTasks(workspaceId, callback)` criado na Etapa 3.
- `onSnapshot` único retornando todas as tasks do workspace.
- Agrupar e ordenar no client por `projectId` e depois por `order` (nomes de
  projeto vêm do `getProjects` já carregado).
- Reutilizar o drawer de task existente sem duplicar código.

---

## Backlog — Não faz parte da migração ativa

### Suporte a múltiplos usuários no workspace (convites)

Adiada — não é foco agora. Mantida aqui como referência para quando entrar
em prioridade.

**Bloqueio conhecido que precisa ser resolvido antes de implementar:**
convidar por e-mail exige buscar um usuário em `users` por
`where("email","==",...)`, mas a regra de `users/{uid}` (leitura só pelo
próprio uid) bloqueia isso por design — não dá para fazer client-side sem
abrir uma brecha de privacidade (permitir qualquer usuário autenticado ler
e-mails de outros). Duas saídas possíveis: (a) uma Cloud Function que faz a
busca com Admin SDK e retorna só o `uid` (sem expor outros dados), ou (b)
uma coleção separada `emailIndex/{email}` com só o campo `uid`, regra de
leitura aberta a qualquer autenticado — menor superfície de dados exposta
que abrir `users` inteiro. (a) é mais seguro mas exige Cloud Functions, o
que quebra o "zero backend próprio" do projeto — vale essa exceção pontual
ou prefere (b)?

**UI — Gerenciamento do workspace:**

- Nova tela acessível pelo navbar: "Workspace" ou ícone de configurações.
- Seção "Membros": lista de membros com nome, email, role. Botão "Convidar
  membro" (só owner vê). Remover membro (só owner, não pode remover a si
  mesmo).

**Fluxo de convite:**

- Owner digita o email do convidado.
- App resolve o email para um `uid` (via uma das duas saídas acima).
- Se encontrar: cria `workspaces/{workspaceId}/members/{uid}` com `uid`,
  `role: "member"`, `joinedAt`.
- Se não encontrar: "Usuário não encontrado — ele precisa criar uma conta
  primeiro".

**Assignees nas tasks:**

- Drawer ganha seção "Responsável" — lista de membros do workspace,
  clique seleciona/deseleciona, salva em `task.assignees: [uid]`.
- Card no board exibe inicial do assignee se houver.

**Regras do Firestore:**

- Revisitar a regra de `members` da Etapa 2 para roles "member" não
  conseguirem deletar projetos/colunas — hoje a regra dá acesso igual a
  qualquer membro, o que é aceitável enquanto só existe o owner, mas precisa
  de uma checagem de `role` antes dessa feature entrar em produção.

### Datas adicionais nas tasks (`startDate`, `dueDate`, `completedDate`)

Ver descrição completa já existente no `CLAUDE.md`, seção "Backlog —
Funcionalidades planejadas". Não depende desta migração de schema — pode
ser feito antes, depois, ou em paralelo, já que só adiciona campos a
`tasks/{taskId}` sem mudar paths.

---

## Notas para o Claude Code

- Executar uma etapa por vez na ordem definida (Etapa 0 → 1 → 2 → 3 → 4 → 5).
- Etapas 0, 1 e 4 são scripts/operações standalone, não fazem parte do app.
- Nunca deletar dados do Firestore sem script de cleanup auditável com logs.
- Manter o app funcional ao final de cada etapa — sem etapas quebradas
  intermediárias.
- Usar `writeBatch` do Firestore para operações que atualizam múltiplos
  documentos.
- Queries com `where` requerem índices compostos no Firestore — criar os
  índices necessários no Firebase Console ou via `firestore.indexes.json`.
  A collection-group query em `members` (Etapa 3) precisa do índice de
  grupo de coleção descrito na Etapa 2, não só um índice normal.
- `serviceAccount.json` nunca vai para o repositório — adicionar ao
  `.gitignore` antes de criar o arquivo.
