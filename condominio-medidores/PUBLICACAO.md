# Publicação na internet — Render + Cloudflare R2

Este guia leva o Controle de Medidores do computador para a internet.
**Nada disto foi executado ainda**: o sistema não está publicado e nenhum domínio foi registrado.

- **Render**: onde o sistema roda. Cuida de servidor, HTTPS e reinícios. Não há VPS para administrar.
- **Cloudflare R2**: guarda uma cópia de cada backup **fora** do Render.
- **Domínio próprio** (ex.: `medidores.suaempresa.com.br`): registrado depois, quando o nome for escolhido.

---

## 1. Custo estimado por mês

| Item | Custo | Observação |
|---|---|---|
| Render — serviço *Starter* | US$ 7,00 | plano mínimo com disco permanente |
| Render — disco de 1 GB | US$ 0,25 | banco, comprovantes e backups locais |
| Cloudflare R2 | US$ 0,00 | grátis até 10 GB guardados (uso estimado: menos de 1 GB) |
| Render — serviço de ensaio | US$ 0,00 | plano gratuito; pode ser apagado depois |
| **Total mensal** | **≈ US$ 7,25 (≈ R$ 40 a R$ 50)** | varia com o dólar e o IOF do cartão |
| Domínio `.com.br` (Registro.br) | ≈ R$ 40 **por ano** | só quando o nome for definido |

Se os comprovantes (fotos/PDF) passarem de 1 GB, o disco pode ser aumentado no painel
(US$ 0,25 por GB por mês). O Render cobra no cartão de crédito internacional, em dólar.

---

## 2. Contas que você precisará criar

1. **GitHub** (já existe) — o código fica aqui; o Render lê o código deste repositório.
   Mantenha o repositório **privado**.
2. **Render** — <https://render.com> (entrar com a conta do GitHub). Precisa de cartão de crédito.
3. **Cloudflare** — <https://dash.cloudflare.com> (para o R2). Pede cartão para ativar o R2,
   mas não cobra dentro do limite gratuito.
4. **Registro.br** — <https://registro.br> (só na etapa do domínio). Precisa de CPF ou CNPJ.

Em **todas** as contas: ative a **verificação em duas etapas (2FA)** e use senhas diferentes.

---

## 3. O que já está pronto no código

| Pronto | Onde |
|---|---|
| Configuração completa do Render (serviço, disco, variáveis, verificação de saúde) | `render.yaml` (raiz do repositório) |
| Serviço de **ensaio** gratuito, só com dados fictícios | `render.yaml` (`controle-medidores-demonstracao`) |
| Sistema **se recusa a iniciar** em produção sem HTTPS, proxy e disco permanente | `src/config.js` |
| Backup diário local (30 cópias) **+ envio ao Cloudflare R2** (90 cópias, banco compactado + comprovantes) | `src/backup.js`, `src/remote-backup.js` |
| Situação do último envio ao R2 em **Configurações → Backup** (e aviso se falhar) | tela de Backup |
| Cópia automática do banco **antes de atualizações** que mudam a estrutura | `src/db.js` |
| Restauração por arquivo ou do R2, sem apagar o banco atual | `npm run restore`, `RESTORE_FROM` |
| Teste do R2 pelo terminal | `npm run backup:remoto` |
| `npm run demo` bloqueado no sistema oficial | `scripts/seed-demo.js` |
| Senha inicial do administrador definida no painel (nunca aparece nos registros) | `ADMIN_PASSWORD` |
| Testes automáticos de tudo acima (42 testes) | `npm test` |

**O que só você pode fazer:** criar as contas, informar o cartão, gerar as chaves do R2,
colar as chaves no painel do Render, escolher e registrar o domínio e apontar o DNS.

---

## 4. Passo a passo (quando decidir publicar)

### 4.1 Levar o código para o ramo principal

O `render.yaml` publica o ramo `main`. O código atual está no ramo de desenvolvimento
`claude/condominio-meter-control-8gt7yp`; antes de publicar, ele precisa ser aprovado e
juntado ao `main` (um *pull request* no GitHub).

### 4.2 Cloudflare R2 (backup externo) — cerca de 10 minutos

1. No painel da Cloudflare: **R2 Object Storage** → ativar o R2 (pede cartão; plano gratuito).
2. **Create bucket** → nome: `medidores-backups` → local: *Automatic* → criar.
   Não ative acesso público.
3. **R2 → Manage R2 API Tokens → Create API token**:
   - Permissão: **Object Read & Write**
   - Aplicar a: **somente o bucket** `medidores-backups`
   - Criar e **anotar** (aparecem só uma vez): *Access Key ID* e *Secret Access Key*.
4. Anote também o **Account ID** (aparece na página inicial do R2).

### 4.3 Render — cerca de 15 minutos

1. No Render: **New → Blueprint** → escolha este repositório (ramo `main`).
2. O Render mostra os dois serviços do `render.yaml`. Preencha:

   | Variável | Valor |
   |---|---|
   | `ADMIN_EMAIL` | seu e-mail de administrador |
   | `ADMIN_PASSWORD` | uma senha provisória forte (o sistema pedirá para trocar no 1º acesso) |
   | `R2_ACCOUNT_ID` | Account ID da Cloudflare |
   | `R2_ACCESS_KEY_ID` | Access Key ID do token |
   | `R2_SECRET_ACCESS_KEY` | Secret Access Key do token |
   | `R2_BUCKET` | `medidores-backups` |

3. **Apply**. Em alguns minutos o sistema estará em um endereço provisório
   `https://controle-medidores.onrender.com` (ou parecido), já com HTTPS.

### 4.4 Ensaio antes de usar de verdade

Use primeiro o serviço **controle-medidores-demonstracao** (dados fictícios; login
`edmilson@condominio.com` / `12345678`). Ele é recriado a cada reinício e dorme quando fica sem
uso (o primeiro acesso pode levar ~1 minuto). **Nunca** cadastre dados reais nele.
Depois do ensaio, apague-o no painel do Render (Settings → Delete).

### 4.5 Conferência do sistema oficial

- [ ] Entrar com `ADMIN_EMAIL`/`ADMIN_PASSWORD` e trocar a senha provisória.
- [ ] **Configurações → Backup → Fazer backup agora**: deve aparecer
      "Cópia externa (Cloudflare R2): último envio em ...".
- [ ] No painel da Cloudflare, o bucket deve ter a pasta `medidores/banco/`.
- [ ] Cadastrar um condomínio, um medidor e uma leitura; anexar um comprovante.
- [ ] No Render → **Manual Deploy** (reinício): os dados devem continuar lá.
- [ ] Abrir no celular.
- [ ] Remover `ADMIN_PASSWORD` do painel do Render (já não é mais usada).

### 4.6 Domínio próprio (etapa futura)

1. Escolher o nome e registrar no Registro.br.
2. No Render: serviço **controle-medidores → Settings → Custom Domains → Add**
   (ex.: `medidores.suaempresa.com.br`). O Render mostra o registro **CNAME** a criar.
3. No Registro.br (ou no DNS da Cloudflare, se preferir): criar o CNAME indicado.
4. Aguardar a verificação: o certificado HTTPS é emitido automaticamente.
   Nenhuma alteração de código é necessária.

---

## 5. Atualizações do sistema

`autoDeploy` está desligado: nada muda sozinho.

1. A nova versão é aprovada e juntada ao `main`.
2. Render → serviço → **Manual Deploy → Deploy latest commit**.
3. Se a atualização mudar a estrutura do banco, uma cópia `antes-da-atualizacao-*.db` é guardada
   automaticamente na pasta de backups.
4. Se algo der errado: Render → **Events/Deploys → Rollback** para a versão anterior.

---

## 6. Restauração de backup

**Do R2 (ex.: disco perdido ou servidor novo):**

1. Render → serviço → **Environment** → adicionar `RESTORE_FROM` = `r2:latest`
   (ou `r2:medidores-AAAA-MM-DD_HHMMSS.db.gz` para um backup específico).
2. Salvar (o Render reinicia). O sistema restaura **antes** de abrir, guarda o banco atual como
   `antes-da-restauracao-*.db` e registra a restauração na Auditoria.
3. **Remova** `RESTORE_FROM` do painel. (Mesmo que esqueça, ela não é aplicada de novo.)

**Pelo terminal (Render → Shell, ou no computador):**

```
npm run backup:remoto            # lista os backups guardados no R2
npm run restore -- r2:latest     # com o sistema parado
```

O Render também tira **cópias diárias do disco** (Render → Disks → Snapshots), que podem ser
restauradas pelo painel — mais uma camada de segurança.

---

## 7. Segurança em produção (já configurado)

- HTTPS obrigatório (cookie `Secure`, HSTS); o sistema não inicia sem essa configuração.
- Senhas e chaves só no painel do Render (nunca no código nem nos registros).
- Token do R2 com acesso **apenas** ao bucket de backups.
- Limite de tentativas de login, troca obrigatória da senha provisória, auditoria completa.
- Dados de demonstração bloqueados no sistema oficial.
