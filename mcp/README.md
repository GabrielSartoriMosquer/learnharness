# LearnHarness MCP

O LearnHarness como servidor MCP remoto (Cloudflare Worker). Claude, ChatGPT e outros clientes que aceitam MCP remoto se conectam a ele e passam a ensinar com a doutrina do LearnHarness. Tudo fica gravado no seu repositório `learnharness-data`, no mesmo formato do app desktop.

**Estado: fase 1.** Já funciona: sessões de ensino (sondar → planejar → ensinar), perguntas e respostas em **modo texto**. Ainda não: cartões interativos (fase 2), prática (fase 3), grafo de conhecimento (fases 4 e 5).

## Como funciona

- **Doutrina:** a mesma do app (`src/agent/prompts/`, com seus overrides de `prompts/` e do `settings.json`), menos 4 trechos de ferramentas exclusivas do app, mais `mcp/prompts/`. É gerada a cada deploy, então atualizações do upstream entram sozinhas.
- **Ferramentas:** `probe`/`recall`, `quiz`/`explain`, `ask_user_question`, `probe_done` e `plan_init` são **as próprias ferramentas do app** (mesmos esquemas, descrições e validações). Ferramentas novas do MCP: `start_session`, `list_sessions`, `resume_session`, `teach` (explicações) e `submit_answer` (respostas).
- **Dados:** cada ação lê o repo numa versão fixa e grava **um commit**. Se o desktop tiver feito push em outros arquivos, o commit é refeito por cima. Se tiver mexido nos mesmos arquivos, **nada é gravado** e o modelo recebe o aviso.
- **Acesso:** login com GitHub. Só a sua conta (`ALLOWED_GITHUB_USER_ID`) entra. O Worker lê e grava os dados com um token próprio, limitado ao repo de dados.

## Regra com o app desktop

O desktop e o MCP gravam no mesmo repositório:

1. **Antes de abrir o desktop:** dê `git pull` na pasta de dados.
2. **Depois de fechar o desktop:** rode o sync (commit + push).
3. Não use o desktop e o MCP **na mesma sessão** ao mesmo tempo.

Se uma sessão do MCP terminar logo depois de uma resposta sua e você abri-la no desktop, o professor do desktop continua a aula com o modelo configurado lá. É o comportamento normal do app.

## Configuração (uma vez, no seu computador Linux)

Pré-requisitos: Node 22+, git e uma conta gratuita na Cloudflare.

### 1. Código

```bash
git clone https://github.com/GabrielSartoriMosquer/learnharness.git
```
```bash
cd learnharness && git checkout claude/happy-einstein-tnvikp
```
```bash
npm ci --ignore-scripts
```
```bash
cd mcp && npm ci
```

O `npm ci` na raiz é necessário porque o Worker importa o código do app. `--ignore-scripts` evita baixar o Electron.

### 2. Seu ID numérico do GitHub

Abra `https://api.github.com/users/GabrielSartoriMosquer` e copie o campo `"id"`. Cole em `wrangler.jsonc` → `vars.ALLOWED_GITHUB_USER_ID`.

### 3. Token de dados (fine-grained)

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token:
- **Repository access:** *Only select repositories* → `learnharness-data`
- **Permissions → Repository → Contents:** *Read and write*

Guarde o token para o passo 6. Confira em `wrangler.jsonc` se o branch do repo de dados é `main` (`DATA_REPO_BRANCH`).

### 4. Primeiro deploy (para descobrir a URL)

```bash
npx wrangler login
```
```bash
npm run deploy
```

O deploy mostra a URL do Worker, algo como `https://learnharness-mcp.<sua-conta>.workers.dev`. Cole essa URL, **sem barra no final**, em `wrangler.jsonc` → `vars.PUBLIC_URL`.

### 5. OAuth App do GitHub (para o login)

GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App:
- **Homepage URL:** a sua `PUBLIC_URL`
- **Authorization callback URL:** `PUBLIC_URL/callback`

Copie o *Client ID* e gere um *Client secret*.

### 6. Segredos e deploy final

```bash
npx wrangler secret put GITHUB_CLIENT_ID
```
```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
```
```bash
npx wrangler secret put DATA_REPO_TOKEN
```
```bash
npm run deploy
```

### 7. Conectar os clientes

O endereço do conector é `PUBLIC_URL/mcp`.

- **Claude (web, desktop, celular):** Configurações → Conectores → *Adicionar conector personalizado* → cole a URL. Depois do login no GitHub, o conector aparece em todos os seus dispositivos.
- **ChatGPT:** Configurações → Apps e conectores → ative o modo desenvolvedor → crie um conector com a URL.
- **CLIs (Claude Code, Gemini CLI etc.):** adicione um servidor MCP remoto com a URL; eles abrem o login no navegador.

Os nomes dos menus mudam com frequência. Se não achar, procure "conector personalizado" ou "MCP" nas configurações do cliente.

## Usar

- **Nova sessão:** "Quero aprender X com o LearnHarness". O modelo chama `start_session` e segue a doutrina.
- **Continuar:** "Continua minha sessão do LearnHarness sobre X". O modelo chama `list_sessions` e `resume_session`.
- **Modo texto:** o modelo mostra a pergunta e você responde no chat, se quiser com a confiança (0, 30, 50, 70, 90 ou 100) e o seu raciocínio.

## Desenvolvimento

```bash
npm test
```
```bash
npm run typecheck
```

Os testes rodam o fluxo completo contra um repositório em memória e conferem que o armazenamento do próprio desktop lê as sessões gravadas.
