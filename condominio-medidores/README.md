# Controle de Medidores — Condomínios

Sistema web para administradores e síndicos controlarem as leituras de **água, gás e energia**
de vários condomínios, substituindo as planilhas manuais.

- Registro de leitura em poucos toques (feito para o celular)
- **Consumo calculado automaticamente** (leitura atual − leitura anterior)
- Histórico no formato de planilha (Data · Dia · Água · Consumo · Gás · Consumo · Horário · Responsável)
- Leituras da concessionária (com comprovante em PDF/foto)
- Calendário, alertas, fechamento do mês, gráficos (3/6/12 meses)
- Relatórios em **PDF, Excel e CSV**
- Usuários com permissões (Administrador / Operador) e **auditoria** de todas as alterações
- Vários condomínios, cada um com seus medidores e histórico separados

---

## Como instalar e usar

1. Instale o **Node.js** (versão 18 ou mais nova): https://nodejs.org — baixe a versão "LTS" e instale.
2. Abra o terminal (Prompt de Comando no Windows) dentro da pasta `condominio-medidores`.
3. Instale o sistema (só na primeira vez):
   ```
   npm install
   ```
4. Inicie o sistema:
   ```
   npm start
   ```
5. Abra o navegador em **http://localhost:3000**

### Primeiro acesso

Na primeira vez que o sistema é iniciado, ele cria o administrador e **mostra a senha no terminal**:

```
  ================= PRIMEIRO ACESSO =================
    E-mail: admin@admin.com
    Senha:  (senha aleatória)
```

Anote essa senha. No primeiro acesso o sistema exige que ela seja trocada (mínimo de 8 caracteres).
Depois cadastre os usuários em **Configurações → Usuários**.

> Para escolher o e-mail/senha iniciais, crie um arquivo `.env` (veja `.env.example`) com
> `ADMIN_EMAIL` e `ADMIN_PASSWORD` **antes** de iniciar o sistema pela primeira vez.

### Dados de demonstração (opcional)

Para conhecer o sistema com exemplos (Geo Paulista, Flow Perdizes e IS Moema), crie um banco separado:

```
DB_FILE=data/demo.db npm run demo
DB_FILE=data/demo.db npm start
```

> O comando `npm run demo` **se recusa a rodar** se o banco já tiver dados reais — nada é apagado.
> Acessos da demonstração: `edmilson@condominio.com` / `12345678` (administrador),
> `maria@condominio.com` / `12345678` (operador) e `admin@admin.com` / `admin12345`.

### Backup

- O sistema faz **um backup automático por dia** (banco de dados + comprovantes) na pasta
  `data/backups/` e guarda os 30 mais recentes.
- Em **Configurações → Backup** o administrador pode fazer um backup na hora e **baixar** a cópia.
  Guarde uma cópia **fora do servidor** (computador, pen drive ou nuvem) regularmente.
- Quando o **Cloudflare R2** está configurado (sistema publicado), cada backup também é enviado
  para fora do servidor. A situação do último envio aparece em Configurações → Backup.
- Antes de qualquer atualização que mude a estrutura do banco, o sistema guarda uma cópia
  (`antes-da-atualizacao-*.db`) na pasta de backups.
- **Para restaurar:** pare o sistema e rode `npm run restore -- caminho/do/backup.db`
  (ou `npm run restore -- r2:latest` para o mais recente do R2). O banco atual não é apagado:
  ele fica guardado como `antes-da-restauracao-*.db`. No Render, veja [PUBLICACAO.md](PUBLICACAO.md).

---

## Como funciona o cálculo

- O **consumo** de cada leitura é a diferença para a leitura anterior do mesmo medidor.
  Ex.: 478,0 m³ → 498,0 m³ = **20,0 m³**. Ele nunca é digitado: é recalculado automaticamente
  sempre que uma leitura é incluída, corrigida ou excluída.
- **Leitura menor que a anterior** é bloqueada. Para salvar, o usuário precisa informar a
  **ocorrência** — troca do medidor, zeramento, correção de leitura ou outra — e descrevê-la.
  Nessa leitura o consumo **não é calculado** automaticamente; ela vira a nova base e aparece nos
  alertas (correção/outra pedem conferência da leitura anterior).
- **Possível erro de digitação:** se o consumo calculado for mais de 3 vezes o normal do medidor
  (média das últimas leituras), o sistema pede confirmação antes de salvar.

### Fechamento do mês (regra da planilha)

A leitura do **dia 01** fecha o mês anterior **e** é a leitura inicial do novo mês:

```
31/08 – leitura
01/09 – leitura de fechamento de agosto  → consumo 31/08→01/09 pertence a AGOSTO
08/09 – nova leitura                     → consumo 01/09→08/09 pertence a SETEMBRO
```

- **Leitura inicial** do mês = leitura do dia 01 (ou, se não houver, a última leitura antes do mês).
- **Leitura final** = leitura do dia 01 do mês seguinte (ou a última leitura registrada no mês).
- **Consumo do mês** = soma dos consumos das leituras de 02/MM até 01/(MM+1).
- Cada intervalo entre leituras pertence a um único mês: **nada é contado duas vezes**
  (a soma dos 12 meses é igual ao consumo do ano).
- A mesma regra vale para o dashboard, gráficos, relatórios e exportações. No relatório, a leitura
  inicial aparece como referência ("leitura inicial") e o consumo dela não entra no total.
- O fechamento pode ser gravado (e reaberto) pelo administrador; se uma leitura for alterada depois,
  o sistema avisa.

### Dias sem leitura (leitura diária)

Se um dia não tiver leitura, o sistema mostra **"Leitura não realizada"** — ele **nunca inventa** uma
leitura do medidor — e o dia continua como **pendência** no dashboard e no calendário.

Quando a leitura seguinte é feita, o consumo que o medidor mediu no intervalo é dividido:

```
20/09 — leitura real: 500,0 m³
21/09 — Leitura não realizada → consumo ESTIMADO: 3,5 m³ (média diária anterior)
22/09 — leitura real: 508,0 m³ → consumo REGISTRADO: 4,5 m³ (8,0 medidos − 3,5 estimados)
Total considerado no intervalo: 8,0 m³ (= 508,0 − 500,0, exatamente o que o medidor mediu)
```

- **Média diária anterior:** dias com leitura em dias consecutivos, sem ocorrência, nos 30 dias antes
  do intervalo (mínimo de 3 dias). Sem isso: **"Não há histórico suficiente para estimativa."** — o
  consumo medido fica todo no dia da leitura real e nada é estimado.
- A estimativa **nunca aumenta** o consumo: se a média for maior que o medido, ela é limitada para o
  dia da leitura real não ficar negativo.
- Dias sem leitura **depois da última leitura** aguardam a próxima leitura (sem estimativa).
- A estimativa respeita a regra do mês: o dia 01 sem leitura tem o consumo estimado no mês anterior.
- **Fechamento e relatório** mostram: consumo registrado, consumo estimado, consumo total considerado,
  dias com leitura e dias sem leitura, com o aviso *"Este período possui N dias sem leitura. O consumo
  desses dias foi estimado com base na média diária anterior."*
- **Comparação com meses anteriores** usa a **média diária** (consumo ÷ dias apurados), não o
  consumo bruto: 20 m³ em 4 dias e 150 m³ em 30 dias são 5 m³/dia nos dois casos (0%).

### Outras regras

- Totais do dashboard, gráficos e relatórios somam os medidores **principais**. Medidores de
  **área específica** (piscina, academia...) aparecem separados, para não somar em dobro.
- **Frequência de leitura:** o padrão é **DIÁRIA** (uma leitura da administração por dia).
  Cada condomínio tem uma frequência padrão (usada ao cadastrar medidores) e cada medidor pode ter a
  sua (diária, semanal, quinzenal, mensal), se algum precisar de frequência diferente.
  - **Medidor diário:** espera-se uma leitura por dia a partir da primeira leitura. Cada dia anterior
    a hoje sem leitura aparece como **pendente** (vermelho) no calendário, no dashboard e nos alertas.
    A leitura de hoje aparece como programada (amarelo) até ser registrada.
  - **Outras frequências:** próxima leitura = última leitura + frequência do medidor.
- As **leituras oficiais das concessionárias** são controladas separadamente, com a data realizada
  (não pode ser futura), a próxima leitura prevista e o comprovante.
- **Alerta de consumo alto**: consumo médio por dia dos últimos 30 dias × média dos 6 meses anteriores
  (percentual configurável em Configurações → Geral).

## Permissões

| Ação | Administrador | Operador |
|---|:-:|:-:|
| Registrar leituras (condomínio e concessionária) | ✓ | ✓ |
| Consultar histórico, calendário, gráficos | ✓ | ✓ |
| Gerar relatórios e exportar | ✓ | ✓ |
| Cadastrar/editar condomínios e medidores | ✓ | |
| Editar e excluir leituras | ✓ | |
| Fechar o mês | ✓ | |
| Gerenciar usuários, configurações, backup e ver auditoria | ✓ | |

---

## Publicação na internet

**Forma escolhida: Render + Cloudflare R2.** O passo a passo completo (contas, custos,
configurações, domínio, restauração e atualização) está em **[PUBLICACAO.md](PUBLICACAO.md)**;
a configuração do Render já está pronta no arquivo `render.yaml` (na raiz do repositório).

Alternativa: qualquer servidor com Node.js 22 (ou Docker). O essencial:

1. **Servidor com disco permanente** (VPS — ex.: Hostinger, Locaweb, DigitalOcean, AWS Lightsail).
   Evite hospedagens que apagam os arquivos a cada reinício: o banco e os comprovantes ficam em disco.
2. **HTTPS** com um proxy (Caddy ou Nginx) na frente do sistema, e no `.env`:
   `TRUST_PROXY=1` e `COOKIE_SECURE=true`.
3. **Manter rodando e reiniciar sozinho:** Docker (`restart: unless-stopped`) ou systemd/pm2.
4. **Backup fora do servidor:** baixe o backup em Configurações → Backup ou copie `dados/backups/`.

### Com Docker (recomendado)

```
cp .env.example .env        # ajuste ADMIN_EMAIL / ADMIN_PASSWORD
docker compose up -d        # dados ficam na pasta ./dados do servidor
docker compose logs         # mostra a senha inicial, se não definiu ADMIN_PASSWORD
```

O `docker-compose.yml` expõe o sistema só em `127.0.0.1:3000`. Exemplo de proxy com **Caddy**
(o certificado HTTPS é automático), arquivo `/etc/caddy/Caddyfile`:

```
medidores.suaempresa.com.br {
    reverse_proxy 127.0.0.1:3000
}
```

### Sem Docker (Node.js direto)

```
npm ci --omit=dev
cp .env.example .env        # ajuste as opções
node server.js              # ou use pm2/systemd para manter rodando
```

## Informações técnicas

- **Backend:** Node.js + Express, banco **SQLite** (arquivo único, sem servidor de banco)
- **Frontend:** HTML/CSS/JavaScript sem etapa de build (Chart.js e Lucide servidos localmente)
- **Exportação:** PDFKit (PDF) e ExcelJS (Excel)
- **Segurança:** senhas com bcrypt (mínimo 8 caracteres), troca obrigatória da senha provisória,
  sessão em cookie HttpOnly (Secure em HTTPS), proteção CSRF, CSP/HSTS, limite de tentativas de login
  por conta, consultas parametrizadas, proteção contra fórmulas no CSV, auditoria com dados completos

### Estrutura do banco

```
users ─┬─< sessions
       └─< audit_logs
condominiums ─< meters ─┬─< readings                 (leituras do condomínio)
                        ├─< utility_company_readings (leituras da concessionária)
                        └─< monthly_closings         (fechamentos gravados)
utility_types ─< meters   (água, gás, energia + solar, combustível, outros)
settings                  (nome, logo, parâmetros de alerta)
```

Cada leitura guarda a leitura anterior e o consumo, recalculados automaticamente pelo sistema
(`recalcMeter`) sempre que uma leitura do medidor muda. Assim todas as consultas usam índices:
com 50 condomínios e 5 anos de leituras semanais, dashboard e relatórios respondem em milissegundos.
Bancos de versões anteriores são atualizados automaticamente ao iniciar (sem perda de dados). Novos tipos de medidor
(energia solar, combustível, outros) já estão cadastrados e podem ser ativados em
**Configurações → Geral**.

### Pastas

```
server.js            inicia o servidor
src/db.js            estrutura do banco
src/services.js      regras: consumo, programação, alertas, fechamento, gráficos
src/reports.js       relatório e exportação PDF/Excel/CSV
src/backup.js        backup automático diário
src/remote-backup.js cópia dos backups no Cloudflare R2
src/restore.js       restauração de backup (arquivo ou R2)
src/config.js        conferência das configurações de produção
src/estimates.js     dias sem leitura e consumo estimado
src/routes/          API (condomínios, medidores, leituras, concessionária, painel, admin)
public/              interface (index.html, css, js/pages/*)
scripts/seed-demo.js dados de demonstração
scripts/restore.js   npm run restore
scripts/backup-remoto.js  npm run backup:remoto (lista/testa o R2)
test/                testes automáticos (npm test)
```

### Variáveis de ambiente (opcionais)

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | porta do servidor |
| `DB_FILE` | `data/medidores.db` | arquivo do banco |
| `DATA_DIR` | `data` | pasta dos comprovantes/logo |
| `BACKUP_DIR` | `data/backups` | pasta dos backups |
| `BACKUP_KEEP` | `30` | quantos backups manter |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | primeiro administrador (banco vazio) |
| `TRUST_PROXY` | `loopback` | use `1` atrás de proxy HTTPS |
| `COOKIE_SECURE` | automático | `true` em produção com HTTPS |
| `TZ` | `America/Sao_Paulo` | fuso horário |
| `NODE_ENV` | — | `production` exige HTTPS, proxy e disco permanente |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | — | backup externo no Cloudflare R2 |
| `BACKUP_REMOTE_KEEP` | `90` | quantos backups manter no R2 |
| `RESTORE_FROM` | — | restaura um backup ao iniciar (uma única vez) |
| `DEMO_ON_START` | — | só no serviço de demonstração |

As variáveis podem ser colocadas no arquivo `.env` (modelo em `.env.example`).
