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

| E-mail | Senha |
|---|---|
| `admin@admin.com` | `admin123` |

O sistema pede para trocar a senha no primeiro acesso. Depois cadastre os usuários em
**Configurações → Usuários**.

### Usar no celular

Com o computador e o celular na mesma rede Wi-Fi, acesse no celular o endereço
`http://IP-DO-COMPUTADOR:3000` (ex.: `http://192.168.0.10:3000`). Para usar fora do condomínio,
o sistema pode ser instalado em um servidor/hospedagem com Node.js.

### Dados de demonstração (opcional)

Para conhecer o sistema com exemplos (Geo Paulista, Flow Perdizes e IS Moema):

```
npm run demo
```

> ⚠️ Esse comando **apaga** o banco atual e cria dados fictícios. Use apenas para testar.
> Acessos da demonstração: `edmilson@condominio.com` / `123456` (administrador) e
> `maria@condominio.com` / `123456` (operador).

### Cópia de segurança (backup)

Todos os dados ficam na pasta `data/`:

- `data/medidores.db` — banco de dados
- `data/uploads/` — comprovantes e logo

Para fazer backup, pare o sistema e copie a pasta `data/` inteira.

---

## Como funciona o cálculo

- O **consumo** de cada leitura é a diferença para a leitura anterior do mesmo medidor.
  Ex.: 478,0 m³ → 498,0 m³ = **20,0 m³**. Ele nunca é digitado: se uma leitura antiga for
  corrigida, todos os consumos são recalculados automaticamente.
- Leituras menores que a anterior são bloqueadas. Se o medidor foi **trocado ou zerado**,
  marque essa opção ao registrar — a leitura vira a nova base e não gera consumo.
- **Fechamento do mês**: leitura inicial = última leitura antes do mês (ou a primeira do mês),
  leitura final = última leitura do mês, consumo = soma dos consumos das leituras do mês.
  O fechamento pode ser gravado (e reaberto) pelo administrador.
- Totais do dashboard, gráficos e relatórios somam os medidores **principais**. Medidores de
  **área específica** (piscina, academia...) aparecem separados, para não somar em dobro.
- **Próxima leitura** = data da última leitura + frequência do medidor (diária, semanal,
  quinzenal ou mensal).
- **Alerta de consumo alto**: compara o consumo médio por dia dos últimos 30 dias com a média
  dos 6 meses anteriores (percentual configurável em Configurações → Geral).

## Permissões

| Ação | Administrador | Operador |
|---|:-:|:-:|
| Registrar leituras (condomínio e concessionária) | ✓ | ✓ |
| Consultar histórico, calendário, gráficos | ✓ | ✓ |
| Gerar relatórios e exportar | ✓ | ✓ |
| Cadastrar/editar condomínios e medidores | ✓ | |
| Editar e excluir leituras | ✓ | |
| Fechar o mês | ✓ | |
| Gerenciar usuários, configurações e ver auditoria | ✓ | |

---

## Informações técnicas

- **Backend:** Node.js + Express, banco **SQLite** (arquivo único, sem servidor de banco)
- **Frontend:** HTML/CSS/JavaScript sem etapa de build (Chart.js e Lucide servidos localmente)
- **Exportação:** PDFKit (PDF) e ExcelJS (Excel)
- **Segurança:** senhas com bcrypt, sessão em cookie HttpOnly, proteção CSRF, consultas parametrizadas

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

O consumo é calculado pela view `v_readings` (função `LAG` do SQLite). Novos tipos de medidor
(energia solar, combustível, outros) já estão cadastrados e podem ser ativados em
**Configurações → Geral**.

### Pastas

```
server.js            inicia o servidor
src/db.js            estrutura do banco
src/services.js      regras: consumo, programação, alertas, fechamento, gráficos
src/reports.js       relatório e exportação PDF/Excel/CSV
src/routes/          API (condomínios, medidores, leituras, concessionária, painel, admin)
public/              interface (index.html, css, js/pages/*)
scripts/seed-demo.js dados de demonstração
test/                testes automáticos (npm test)
```

### Variáveis de ambiente (opcionais)

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | porta do servidor |
| `DB_FILE` | `data/medidores.db` | arquivo do banco |
| `DATA_DIR` | `data` | pasta dos comprovantes/logo |
| `TZ` | `America/Sao_Paulo` | fuso horário |

Em produção, use HTTPS (por exemplo, atrás de um proxy como Nginx ou de um serviço de hospedagem).
