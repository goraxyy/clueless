// Clueless website: the scroll story (one problem, start to finish) and the hint ladder.
// No libraries. Everything still reads fine without it.

;(() => {
  // ── The scroll story: on wide screens the scene stays put while you scroll through four steps;
  //    on phones a "Next step" button moves it along.
  const story = document.querySelector('.story')
  if (story) {
    const steps = [...story.querySelectorAll('.steps li')]
    const next = story.querySelector('.story-next')
    let current = -1
    const show = (step) => {
      if (step === current) return
      current = step
      story.dataset.step = String(step)
      steps.forEach((li, i) => li.classList.toggle('on', i === step))
      story.querySelectorAll('[data-show]').forEach((el) => {
        el.style.display = Number(el.dataset.show) === step ? 'block' : 'none'
      })
      story.querySelectorAll('[data-from]').forEach((el) => el.classList.toggle('show', step >= Number(el.dataset.from)))
      if (next) next.textContent = step === steps.length - 1 ? 'Start again ↺' : 'Next step →'
    }
    const wide = window.matchMedia('(min-width: 901px)')
    const onScroll = () => {
      if (!wide.matches) return
      const box = story.getBoundingClientRect()
      const travel = box.height - window.innerHeight
      const progress = Math.min(Math.max(-box.top / travel, 0), 0.999)
      show(Math.floor(progress * steps.length))
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    wide.addEventListener('change', onScroll)
    next?.addEventListener('click', () => show((current + 1) % steps.length))
    show(0)
    onScroll()
  }

  // ── The hint ladder: each click opens the next rung.
  const ladder = document.querySelector('.problem-card')
  if (ladder) {
    const rungs = [...ladder.querySelectorAll('.rung')]
    const nextButton = ladder.querySelector('[data-ladder="next"]')
    const reset = ladder.querySelector('[data-ladder="reset"]')
    const note = ladder.querySelector('[data-ladder="note"]')
    let open = 1
    const render = () => {
      rungs.forEach((r, i) => r.classList.toggle('open', i < open))
      nextButton.disabled = open >= rungs.length
      note.textContent = open >= rungs.length ? 'now write it yourself ✎' : `hint ${open} of ${rungs.length}`
    }
    nextButton.addEventListener('click', () => {
      open = Math.min(open + 1, rungs.length)
      render()
    })
    reset.addEventListener('click', () => {
      open = 1
      render()
    })
    render()
  }

  // ── See it: the Animate window. Three demos (code, math, physics), each a list of steps the
  //    window plays through like the app's visual island. Each one stops before the final answer.
  const see = document.querySelector('.see')
  if (see) {
    const part = (name) => see.querySelector(`[data-island="${name}"]`)
    const island = see.querySelector('.island')
    const view = part('view')
    const say = part('say')
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const SPEEDS = [1, 1.5, 2]
    let speed = 1
    let demo = null
    let index = 0
    let timer = null
    let playing = false
    let userPaused = false
    let onScreen = false

    // Bubble sort, run for real: every comparison and swap, with the running line lit up.
    const codeDemo = () => {
      const a = [5, 2, 8, 1, 4].map((v, id) => ({ v, id }))
      const done = new Set()
      const steps = []
      const snap = (line, look, text, ms) => steps.push({ line, look, order: a.map((e) => e.id), done: [...done], say: text, ms })
      for (let i = 0; i < a.length - 1; i++) {
        for (let j = 0; j < a.length - 1 - i; j++) {
          const [x, y] = [a[j].v, a[j + 1].v]
          snap(4, [j, j + 1], `Is <b>${x}</b> bigger than <b>${y}</b>? ${x > y ? 'Yes.' : 'No, so they stay.'}`)
          if (x > y) {
            ;[a[j], a[j + 1]] = [a[j + 1], a[j]]
            snap(5, [j, j + 1], `So they swap: <b>${y}</b> moves left.`)
          }
        }
        done.add(a[a.length - 1 - i].id)
        snap(2, [], `<b>${a[a.length - 1 - i].v}</b> has bubbled to the end. Next pass.`)
      }
      done.add(a[0].id)
      snap(6, [], 'Sorted. <b>Your turn: why does each pass check one fewer pair?</b>', 4200)
      const values = [5, 2, 8, 1, 4]
      return {
        title: 'bubble_sort([5, 2, 8, 1, 4])',
        source: 'code',
        steps,
        setup() {
          view.innerHTML =
            '<div class="bars">' +
            values.map((v, id) => `<div class="bar" data-id="${id}" style="height:${22 + (v / 8) * 78}%">${v}</div>`).join('') +
            values.map((_, p) => `<span class="idx" style="left:${p * 21}%">a[${p}]</span>`).join('') +
            '<span class="pointer"></span></div>'
        },
        draw(step) {
          step.order.forEach((id, p) => {
            const bar = view.querySelector(`.bar[data-id="${id}"]`)
            bar.style.left = `${p * 21}%`
            bar.classList.toggle('look', step.look.includes(p))
            bar.classList.toggle('done', step.done.includes(id))
          })
          const pointer = view.querySelector('.pointer')
          pointer.style.opacity = step.look.length ? '1' : '0'
          if (step.look.length) {
            pointer.style.left = `${step.look[0] * 21}%`
            pointer.style.width = `${37}%`
          }
          const lines = [...see.querySelectorAll('.lines li')]
          lines.forEach((li, n) => li.classList.toggle('on', n === step.line - 1))
          const on = lines[step.line - 1]
          const marker = see.querySelector('.running')
          if (on && marker) marker.style.top = `${on.offsetTop - 1}px`
        }
      }
    }

    // A parabola: a tangent slides along until the slope is zero. Where is it lowest?
    const mathDemo = () => {
      const f = (x) => x * x - 4 * x + 3
      const slope = (x) => 2 * x - 4
      const X = (x) => 26 + ((x + 0.5) / 5) * 320
      const Y = (y) => 172 - ((y + 1.5) / 7) * 158
      const ux = 320 / 5
      const uy = 158 / 7
      const curve = Array.from({ length: 51 }, (_, k) => -0.5 + k * 0.1)
        .map((x, k) => `${k ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(f(x)).toFixed(1)}`)
        .join(' ')
      const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0')
      const at = [null, 0, 1, 2, 3, 2]
      const says = [
        'f(x) = x² − 4x + 3. Where is it lowest? <b>Follow the slope.</b>',
        'At x = 0 the slope is <b>−4</b>: still heading down.',
        'At x = 1 it is <b>−2</b>. Less steep, still going down.',
        'At x = 2 the slope is <b>0</b>. Flat: this is the bottom.',
        'At x = 3 it is <b>+2</b>, so it is climbing again.',
        'The lowest point is at x = 2. <b>Your turn: what is f(2)?</b>'
      ]
      return {
        title: 'f(x) = x² − 4x + 3',
        source: 'math',
        steps: at.map((x, k) => ({ x, say: says[k], ms: k === at.length - 1 ? 4200 : 1700 })),
        setup() {
          const ticks = [1, 2, 3, 4]
            .map((t) => `<line x1="${X(t)}" y1="${Y(0) - 3}" x2="${X(t)}" y2="${Y(0) + 3}" stroke="#71717a"/><text x="${X(t)}" y="${Y(0) + 15}" fill="#71717a" font-size="10" text-anchor="middle">${t}</text>`)
            .join('')
          view.innerHTML = `<svg viewBox="0 0 372 190" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <line x1="${X(-0.5)}" y1="${Y(0)}" x2="${X(4.5)}" y2="${Y(0)}" stroke="#52525b"/>
            <line x1="${X(0)}" y1="${Y(-1.5)}" x2="${X(0)}" y2="${Y(5.4)}" stroke="#52525b"/>${ticks}
            <path d="${curve}" fill="none" stroke="#e4e4e7" stroke-width="2.4" stroke-linecap="round"/>
            <line class="drop" x1="${X(2)}" y1="${Y(-1)}" x2="${X(2)}" y2="${Y(0)}" stroke="#d97757" stroke-dasharray="4 4" style="opacity:0;transition:opacity .4s"/>
            <g class="touch" style="transition:transform .6s cubic-bezier(.3,.7,.3,1),opacity .3s;opacity:0">
              <line x1="-58" y1="0" x2="58" y2="0" stroke="#d97757" stroke-width="2.4" stroke-linecap="round"/>
              <circle r="5.5" fill="#d97757" stroke="#0a0a0d" stroke-width="2"/>
            </g>
            <text class="tag" font-size="12" font-weight="600" fill="#f0a487" style="transition:opacity .3s"></text>
          </svg>`
        },
        draw(step) {
          const touch = view.querySelector('.touch')
          const tag = view.querySelector('.tag')
          const drop = view.querySelector('.drop')
          drop.style.opacity = step === this.steps.at(-1) ? '1' : '0'
          if (step.x === null) {
            touch.style.opacity = '0'
            tag.style.opacity = '0'
            return
          }
          const angle = (-Math.atan((slope(step.x) * uy) / ux) * 180) / Math.PI
          touch.style.opacity = '1'
          touch.style.transform = `translate(${X(step.x)}px, ${Y(f(step.x))}px) rotate(${angle}deg)`
          tag.style.opacity = '1'
          tag.setAttribute('x', String(X(step.x) + 12))
          tag.setAttribute('y', String(Y(f(step.x)) - 12))
          tag.textContent = `slope ${sign(slope(step.x))}`
        }
      }
    }

    // A block on a ramp: the forces appear one at a time. What is left to speed it up?
    const physicsDemo = () => {
      const A = [62, 174]
      const base = 268
      const dx = Math.cos(Math.PI / 6)
      const dy = Math.sin(Math.PI / 6)
      const top = [A[0] + base, A[1] - base * Math.tan(Math.PI / 6)]
      const center = (s) => [A[0] + s * dx - 7.5, A[1] - s * dy - 13]
      const arrow = (cls, x2, y2, color, dash = '') =>
        `<line class="${cls}" x1="0" y1="0" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="2.6" ${dash} marker-end="url(#tip-${color.slice(1)})" style="opacity:0;transition:opacity .4s"/>`
      const label = (cls, x, y, text, color) => `<text class="${cls}" x="${x}" y="${y}" fill="${color}" font-size="11" font-weight="600" style="opacity:0;transition:opacity .4s">${text}</text>`
      const tips = ['#e4e4e7', '#a1a1aa', '#60a5fa', '#d97757']
        .map((c) => `<marker id="tip-${c.slice(1)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`)
        .join('')
      const steps = [
        { s: 205, show: [], say: 'A 5 kg block on a 30° ramp. No friction.' },
        { s: 205, show: ['g'], say: 'Gravity pulls straight down: <b>mg = 49 N</b>.' },
        { s: 205, show: ['g', 'along', 'into'], say: 'Split it in two: <b>24.5 N</b> along the ramp and <b>42.4 N</b> into it.' },
        { s: 205, show: ['along', 'into', 'n'], say: 'The ramp pushes back with 42.4 N, so those two cancel out.' },
        { s: 110, show: ['a'], say: 'Only the 24.5 N along the ramp is left. <b>Your turn: a = F ÷ m = ?</b>', ms: 4200 }
      ]
      return {
        title: 'block on a 30° ramp',
        source: 'physics',
        steps: steps.map((st) => ({ ms: 1900, ...st })),
        setup() {
          view.innerHTML = `<svg viewBox="0 0 372 190" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <defs>${tips}</defs>
            <path d="M${A[0]} ${A[1]} L${top[0]} ${A[1]} L${top[0]} ${top[1]} Z" fill="rgba(255,255,255,.06)" stroke="#52525b"/>
            <path d="M${A[0] + 34} ${A[1]} A34 34 0 0 0 ${A[0] + 34 * dx} ${A[1] - 34 * dy}" fill="none" stroke="#71717a"/>
            <text x="${A[0] + 40}" y="${A[1] - 6}" fill="#a1a1aa" font-size="11">30°</text>
            <g class="block" style="transition:transform .9s cubic-bezier(.4,.1,.3,1)">
              <rect x="-18" y="-30" width="36" height="30" rx="4" fill="#d97757"/>
              <text x="0" y="-11" fill="#fff" font-size="11" font-weight="700" text-anchor="middle">5 kg</text>
            </g>
            <g class="forces" style="transition:transform .9s cubic-bezier(.4,.1,.3,1)">
              ${arrow('g', 0, 64, '#e4e4e7')}
              ${arrow('along', -32 * dx, 32 * dy, '#a1a1aa', 'stroke-dasharray="5 4"')}
              ${arrow('into', 55 * dy, 55 * dx, '#a1a1aa', 'stroke-dasharray="5 4"')}
              ${arrow('n', -55 * dy, -55 * dx, '#60a5fa')}
              ${arrow('a', -58 * dx, 58 * dy, '#d97757')}
              ${label('g', 6, 66, 'mg', '#e4e4e7')}
              ${label('along', -66, 34, '24.5 N', '#a1a1aa')}
              ${label('into', 30, 58, '42.4 N', '#a1a1aa')}
              ${label('n', -58, -48, 'N', '#60a5fa')}
              ${label('a', -74, 26, 'a = ?', '#f0a487')}
            </g>
          </svg>`
        },
        draw(step) {
          const block = view.querySelector('.block')
          const forces = view.querySelector('.forces')
          const p = [A[0] + step.s * dx, A[1] - step.s * dy]
          block.style.transform = `translate(${p[0]}px, ${p[1]}px) rotate(-30deg)`
          const c = center(step.s)
          forces.style.transform = `translate(${c[0]}px, ${c[1]}px)`
          for (const name of ['g', 'along', 'into', 'n', 'a']) {
            view.querySelectorAll(`.${name}`).forEach((el) => (el.style.opacity = step.show.includes(name) ? '1' : '0'))
          }
        }
      }
    }

    const demos = { code: codeDemo(), math: mathDemo(), physics: physicsDemo() }

    const show = (i) => {
      index = Math.max(0, Math.min(i, demo.steps.length - 1))
      const step = demo.steps[index]
      demo.draw(step)
      say.innerHTML = step.say
      part('count').textContent = `${index + 1} / ${demo.steps.length}`
      part('progress').style.width = `${((index + 1) / demo.steps.length) * 100}%`
    }
    const schedule = () => {
      clearTimeout(timer)
      if (!playing) return
      const atEnd = index >= demo.steps.length - 1
      timer = setTimeout(() => {
        show(atEnd ? 0 : index + 1) // loop after a pause on the last step
        schedule()
      }, (demo.steps[index].ms ?? 1250) / speed)
    }
    const setPlaying = (on) => {
      playing = on
      island.classList.toggle('playing', on)
      part('play').setAttribute('aria-label', on ? 'Pause' : 'Play')
      schedule()
    }
    const choose = (name) => {
      demo = demos[name]
      see.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.demo === name)))
      see.querySelectorAll('[data-source]').forEach((el) => el.classList.toggle('on', el.dataset.source === name))
      part('title').textContent = demo.title
      demo.setup()
      show(0)
      schedule()
    }

    see.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => choose(b.dataset.demo)))
    part('play').addEventListener('click', () => {
      userPaused = playing
      if (!playing && index >= demo.steps.length - 1) show(0)
      setPlaying(!playing)
    })
    part('next').addEventListener('click', () => {
      setPlaying(false)
      userPaused = true
      show(index + 1)
    })
    part('back').addEventListener('click', () => {
      setPlaying(false)
      userPaused = true
      show(index - 1)
    })
    part('speed').addEventListener('click', (e) => {
      speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
      e.currentTarget.textContent = `${speed}×`
      schedule()
    })

    choose('code')
    // Plays while it's on screen (unless the reader paused it or asked for less motion).
    new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting
        if (onScreen && !userPaused && !reduceMotion) setPlaying(true)
        if (!onScreen && playing) setPlaying(false)
      },
      { threshold: 0.35 }
    ).observe(island)
  }
})()
