# Patrimônio

App de finanças pessoais para Android, em preto e branco.

## Funcionalidades

**Ações**
- Carteira com ticker, quantidade e preço médio (B3 e exterior)
- Gráfico da carteira e de cada ativo (1M, 3M, 6M, 1A, 5A), com valor ao arrastar o dedo
- Gráfico de pizza da distribuição da carteira
- Proventos: próximos dividendos e JCP (data com, pagamento, valor por ação e total), recebido em 12 meses e yield

**Cartões**
- Cadastro de cartões com programa de pontos, pontos por dólar e taxa de transferência para milhas
- Lançamento de gastos/faturas e bônus
- Pontos = (gasto em R$ ÷ dólar) × pontos por dólar; milhas e valor estimado em R$
- Pontos por mês, ritmo mensal e projeção de 12 meses

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
