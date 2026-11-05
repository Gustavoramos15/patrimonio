# Patrimônio

App de finanças pessoais para Android, em preto e branco.

## Baixar

**[Patrimonio-v1.5.0.apk](Patrimonio-v1.5.0.apk)** — baixe no celular e abra para instalar (permita instalar de fontes desconhecidas).

## Funcionalidades

**Ações**
- Carteira com ticker, quantidade e preço médio (B3 e exterior)
- Gráfico da carteira e de cada ativo (1M, 3M, 6M, 1A, 5A), com valor ao arrastar o dedo; verde na alta e vermelho na queda
- Gráfico de pizza da distribuição da carteira
- Remover ação direto na tela do ativo
- Importar a carteira pelos relatórios da Área do Investidor da B3 (Posição e, para o preço médio, Negociação ou Movimentação), com prévia antes de aplicar; os arquivos são lidos só no celular
- Proventos: próximos dividendos e JCP (data com, pagamento, valor por ação e total), recebido em 12 meses e yield

**Ibovespa**
- Gráfico do índice (1D a 5A), máxima/mínima do dia e de 52 semanas
- Indicadores: dólar, euro, S&P 500 e bitcoin
- Maiores altas e baixas do dia entre as ações mais negociadas

**Termômetro**
- Dois termômetros (compra e venda), de 0 a 100, em 5 faixas de cor, com o sinal geral (comprar, manter ou vender) e os principais motivos
- Indicadores calculados a partir das demonstrações oficiais da CVM: P/L, P/VP, EV/EBITDA, ROE, ROIC, margem, crescimento de 5 anos, dívida líquida/EBITDA, fluxo de caixa livre, dividendos, valor justo (Graham, Bazin, P/L histórico) e comparação com o próprio histórico
- Critérios e pesos ajustados ao setor (bancos, seguradoras, energia/saneamento/telecom, tecnologia, commodities)
- Dados: `pipeline/cvm_fundamentos.py` gera `data/fundamentos/` a partir do Portal de Dados Abertos da CVM; o GitHub Actions atualiza todo dia
- Análise automática para estudo; não é recomendação de investimento

**Notícias**
- Notícias das ações da carteira (com filtro por ação) e do mercado, via Google Notícias
- Alertas no celular: o app confere as notícias a cada ~5 min, mesmo fechado, e notifica as novas
- Avisos de proventos: quando a ação anuncia dividendo/JCP e, no dia do pagamento, quanto caiu na conta

**Cartões**
- Cadastro de cartões com programa de pontos, pontos por dólar e taxa de transferência para milhas
- Lançamento de gastos/faturas e bônus
- Pontos = (gasto em R$ ÷ dólar) × pontos por dólar; milhas e valor estimado em R$
- Pontos por mês, ritmo mensal e projeção de 12 meses
- Gráfico de pizza dos pontos por cartão
- Remover cartão direto na tela do cartão

Os dados ficam salvos apenas no aparelho (backup em texto nos Ajustes).
Cotações: Yahoo Finance. Proventos da B3: Status Invest.

## Tecnologia

HTML/CSS/JS puro em `www/`, empacotado para Android com [Capacitor 6](https://capacitorjs.com).

## Gerar o APK

Requisitos: Node 18+, JDK 17 e Android SDK (plataforma 34).

```bash
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

O APK sai em `android/app/build/outputs/apk/debug/app-debug.apk`.

> No Windows, se o caminho da pasta tiver acentos, o Gradle falha. Mapeie uma letra de unidade (`subst P: "C:\caminho\da pasta"`) e compile a partir de `P:\android`.
