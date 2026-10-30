#!/usr/bin/env bash
# Roda uma vez, na criação do Codespace: clona o repo de dados, cria o
# atalho ~/sources (as ferramentas do agente resolvem caminhos relativos a
# partir da home — src/agent/tools/fs-shared.ts), instala as dependências e
# o Claude Code (provedor claude-code do settings.json).
set -euo pipefail

DATA_DIR="${LH_DATA_DIR:-/workspaces/learnharness-data}"
DATA_REPO_URL="${DATA_REPO_URL:-https://github.com/GabrielSartoriMosquer/learnharness-data.git}"

if [ ! -d "$DATA_DIR/.git" ]; then
	git clone "$DATA_REPO_URL" "$DATA_DIR"
else
	echo "Repo de dados já existe em $DATA_DIR"
fi

ln -sfn "$DATA_DIR/sources" "$HOME/sources"
echo "Atalho: $HOME/sources -> $DATA_DIR/sources"

if [ "${SKIP_INSTALL:-}" != "1" ]; then
	npm ci
	if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
		curl -fsSL https://claude.ai/install.sh | bash
	fi
	echo "Rode 'claude' uma vez no terminal para fazer login."
fi
