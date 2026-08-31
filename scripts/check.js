/* ═══════════════════════════════════════════════════════════════
   VERIFICAÇÕES ESTÁTICAS DO RENDERER  —  `npm run check`

   O cliente não tem build step: nada compila, nada avisa quando um import
   aponta pra um export que não existe mais ou quando um id some do
   index.html. Como `$()` é getElementById e os módulos se registram no
   carregamento, um id renomeado quebra o app em cascata — e só na hora de
   usar. Estas checagens pegam isso em segundos, sem abrir o Electron:

     1. sintaxe   — cada arquivo é parseado (`node --check`)
     2. imports   — todo `import { x } from './y.js'` existe mesmo em y.js
     3. faltantes — helper de outro módulo usado SEM importar
     4. dom       — todo `$('algum-id')` existe como id no index.html

   As checagens 3 e 4 leem o código com os comentários REMOVIDOS (ver
   semComentarios): sem isso, citar `algumaFuncao()` num comentário — o que
   este projeto faz o tempo todo — viraria um erro.

   Não substitui rodar o app: não executa nada, só lê os arquivos.
═══════════════════════════════════════════════════════════════ */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const SRC = path.join(__dirname, '..', 'src')
const RENDERER = path.join(SRC, 'renderer')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

const rel = (f) => path.relative(SRC, f).replace(/\\/g, '/')
let problemas = 0
const erro = (msg) => { console.log('  x ' + msg); problemas++ }

/* Devolve o código sem os comentários (cada caractere removido vira um
   espaço, então as posições e as linhas continuam batendo). Existe porque
   as checagens 3 e 4 varrem o código por TEXTO, e o padrão da casa é
   comentar denso citando nomes de função — "ver renderIcons() em main.js"
   dentro de um comentário virava um erro de "chama sem importar".

   Precisa entender literal de expressão regular, não só aspas: este
   projeto tem `.replace(/"/g, ...)`. Um scanner que tratasse essa barra
   como divisão entraria em "modo string" na aspa seguinte e embaralharia
   todo o resto do arquivo. A regra é a heurística clássica: uma barra
   começa uma regex quando o último caractere significativo NÃO é
   identificador, número, `)` ou `]` — ou seja, quando ali não caberia uma
   divisão. */
function semComentarios(src) {
  const NL = '\n'
  let fora = ''
  let i = 0
  let anterior = '' // último caractere significativo já emitido

  const fimDeValor = (c) => /[A-Za-z0-9_$)\]]/.test(c)

  while (i < src.length) {
    const c = src[i]
    const prox = src[i + 1]

    // Comentário de linha
    if (c === '/' && prox === '/') {
      while (i < src.length && src[i] !== NL) { fora += ' '; i++ }
      continue
    }

    // Comentário de bloco — as quebras de linha são preservadas
    if (c === '/' && prox === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        fora += src[i] === NL ? NL : ' '
        i++
      }
      fora += '  '
      i += 2
      continue
    }

    // Texto entre aspas ou crases — copiado como está (pode conter // e /*)
    if (c === '"' || c === "'" || c === '`') {
      fora += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { fora += src[i] + (src[i + 1] || ''); i += 2; continue }
        fora += src[i]
        const fechou = src[i] === c
        i++
        if (fechou) break
      }
      anterior = c
      continue
    }

    // Literal de expressão regular
    if (c === '/' && !fimDeValor(anterior)) {
      fora += c
      i++
      let emClasse = false
      while (i < src.length) {
        if (src[i] === '\\') { fora += src[i] + (src[i + 1] || ''); i += 2; continue }
        if (src[i] === '[') emClasse = true
        else if (src[i] === ']') emClasse = false
        fora += src[i]
        const fechou = src[i] === '/' && !emClasse
        i++
        if (fechou) break
      }
      anterior = '/'
      continue
    }

    fora += c
    if (!/\s/.test(c)) anterior = c
    i++
  }

  return fora
}

// Nomes exportados por um módulo. Usado pelas checagens 2 e 3.
const cacheExports = new Map()
function exportsDe(file) {
  if (cacheExports.has(file)) return cacheExports.get(file)
  const src = fs.readFileSync(file, 'utf8')
  const nomes = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) nomes.add(m[1])
  for (const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) nomes.add(m[1])
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    m[1].split(',').forEach((parte) => {
      const as = parte.split(/\s+as\s+/)
      nomes.add((as[1] || as[0]).trim())
    })
  }
  cacheExports.set(file, nomes)
  return nomes
}

// Nomes que um arquivo já tem à mão: importados ou declarados nele mesmo.
function nomesDisponiveis(src) {
  const nomes = new Set()
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    m[1].split(',').forEach((parte) => {
      const as = parte.split(/\s+as\s+/)
      nomes.add((as[1] || as[0]).trim())
    })
  }
  for (const m of src.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) nomes.add(m[1])
  for (const m of src.matchAll(/(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) nomes.add(m[1])
  return nomes
}

/* ── 1. Sintaxe ─────────────────────────────────────────────────
   `node --check` não entende `import` num arquivo .js, então cada um é
   copiado pra .mjs num diretório temporário só pra ser parseado. */
console.log('\nSintaxe')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharesync-check-'))
  const arquivos = walk(SRC)
  for (const f of arquivos) {
    const src = fs.readFileSync(f, 'utf8')
    const ehModulo = /^\s*(import|export)\s/m.test(src)
    const alvo = path.join(tmp, 'check.' + (ehModulo ? 'mjs' : 'cjs'))
    fs.writeFileSync(alvo, src)
    try {
      execFileSync(process.execPath, ['--check', alvo], { stdio: 'pipe' })
    } catch (err) {
      erro(`${rel(f)}\n${String(err.stderr).split('\n').slice(0, 5).join('\n')}`)
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`  ${arquivos.length} arquivos verificados`)
}

/* ── 2. Imports batem com exports ─────────────────────────────── */
console.log('\nImports')
{
  let conferidos = 0
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[2]
      if (!spec.startsWith('.') || spec.includes('node_modules')) continue
      const alvo = path.resolve(path.dirname(file), spec)
      if (!fs.existsSync(alvo)) { erro(`${rel(file)} importa de ${spec}, que não existe`); continue }
      const disponiveis = exportsDe(alvo)
      for (let nome of m[1].split(',')) {
        nome = nome.split(/\s+as\s+/)[0].trim()
        if (!nome) continue
        conferidos++
        if (!disponiveis.has(nome)) erro(`${rel(file)} importa "${nome}", que ${spec} não exporta`)
      }
    }
  }
  console.log(`  ${conferidos} imports conferidos`)
}

/* ── 3. Helper de outro módulo usado sem importar ───────────────
   O caso real que motivou esta checagem: `setIcon(...)` foi chamado em
   webrtc/camera.js sem o import correspondente. A checagem 2 não pega isso
   — ela valida os imports que EXISTEM, e ali não existia nenhum. Em
   runtime virava um ReferenceError no meio de startCamera(), depois de já
   ter ligado a câmera e antes de anunciá-la pra sala: a câmera ficava
   ligada e invisível pra todo mundo, sem erro nenhum na tela.

   Escopo estreito de propósito (só nomes exportados por módulos do próprio
   renderer, e só quando chamados como função) pra pegar essa classe sem
   precisar de um analisador de escopo de verdade. */
console.log('\nHelpers importados')
{
  const arquivos = walk(SRC)
  // nome exportado -> módulo que exporta. Nomes exportados por mais de um
  // lugar saem da lista: aí o import "certo" é ambíguo pra esta heurística.
  const dono = new Map()
  const ambiguos = new Set()
  for (const f of arquivos) {
    for (const nome of exportsDe(f)) {
      if (dono.has(nome) && dono.get(nome) !== f) ambiguos.add(nome)
      else dono.set(nome, f)
    }
  }
  ambiguos.forEach((n) => dono.delete(n))

  for (const file of arquivos) {
    const src = semComentarios(fs.readFileSync(file, 'utf8'))
    const disponiveis = nomesDisponiveis(src)
    const jaAvisado = new Set()
    for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
      const nome = m[1]
      if (!dono.has(nome) || dono.get(nome) === file) continue
      if (disponiveis.has(nome) || jaAvisado.has(nome)) continue
      jaAvisado.add(nome)
      erro(`${rel(file)} chama "${nome}()" sem importar (exportado por ${rel(dono.get(nome))})`)
    }
  }
  console.log(`  ${arquivos.length} arquivos varridos`)
}

/* ── 4. Ids usados pelo JS existem no HTML ────────────────────── */
console.log('\nIds do DOM')
{
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
  const vistos = new Set()
  let conferidos = 0
  for (const f of walk(path.join(RENDERER, 'js'))) {
    const src = semComentarios(fs.readFileSync(f, 'utf8'))
    for (const m of src.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) {
      const id = m[1]
      const chave = f + '|' + id
      if (vistos.has(chave)) continue
      vistos.add(chave)
      conferidos++
      if (!ids.has(id)) erro(`${rel(f)} usa $('${id}'), que não existe no index.html`)
    }
  }
  console.log(`  ${conferidos} ids conferidos`)
}

console.log(problemas ? `\n${problemas} problema(s) encontrado(s)\n` : '\nTudo certo\n')
process.exit(problemas ? 1 : 0)
