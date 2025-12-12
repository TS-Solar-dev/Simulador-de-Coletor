/* 
    SISTEMA DE DIMENSIONAMENTO SOLAR - PRO ENGINEERING
    Versão: 7.2 (Seleção de Coletor Dinâmica)
*/

// =============================================================================
// 1. CONFIGURAÇÕES & TABELAS DE ENGENHARIA
// =============================================================================

const isMobile = window.innerWidth < 768;
const PIXELS_PER_METER = isMobile ? 22 : 40; 
const MIN_SEPARATION_PX = 20;


const FACTOR_MATRIX = {
    'residencial': { 'muito_quente': 1.2, 'quente': 1.4, 'frio': 1.5, 'muito_frio': 1.7 },
    'clubes':      { 'muito_quente': 0.9, 'quente': 1.1, 'frio': 1.2, 'muito_frio': 1.5 },
    'spa':         { 'muito_quente': 0.8, 'quente': 1.0, 'frio': 1.1, 'muito_frio': 1.3 },
    'treinamento': { 'muito_quente': 0.9, 'quente': 1.1, 'frio': 1.2, 'muito_frio': 1.5 }
};

const ORIENTATION_FACTORS = { 'NORTE': 1.0, 'LESTE': 1.2, 'OESTE': 1.1, 'SUL': null };
const DISTRIBUTION_L_O = { LESTE: 0.40, OESTE: 0.60 };

const COLLECTORS = [
    { name: 'Coletor 5M',    len: 5.0,  width: 0.35, area: 1.50 },
    { name: 'Coletor 4M',    len: 4.0,  width: 0.35, area: 1.20 },
    { name: 'Coletor 3.70M', len: 3.7,  width: 0.35, area: 1.11 },
    { name: 'Coletor 3M',    len: 3.0,  width: 0.35, area: 0.90 },
    { name: 'Coletor 2M',    len: 2.0,  width: 0.35, area: 0.60 }
];

const MAX_PLATES_PER_BATTERY = 20;
const BATTERY_GAP = 0.20; 
const MARGIN_SAFETY = 0.5; 

const SALES_TEAMS = {
    'PRISCILA': {
        phone: '5543988249005',
        states: ['SC', 'RS', 'MT', 'MS', 'GO', 'DF', 'RO']
    },
    'ROSIMARY': {
        phone: '5543999890545',
        states: [
            'SP', 'RJ', 'ES', 'TO', 'SE', 'RR', 'RN', 'PI', 'PE', 
            'PB', 'PA', 'MA', 'CE', 'BA', 'AP', 'AM', 'AL', 'AC'
        ]
    },
    'REGIANE': {
        phone: '5543999890550', // PADRÃO (MG, PR e Fallback)
        states: ['MG', 'PR'] 
    }
};

async function getStateFromCoords(lat, lon) {
    try {
        // Usa API gratuita do OpenStreetMap para descobrir o estado
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
        const data = await response.json();
        
        // Tenta pegar o código ISO do estado (ex: "BR-PR")
        const isoCode = data.address['ISO3166-2-lvl4'];
        
        if (isoCode) {
            return isoCode.split('-')[1]; // Retorna apenas "PR", "SP", etc.
        }
        return null;
    } catch (error) {
        console.error("Erro na geocodificação:", error);
        return null;
    }
}

function getSalesPhoneByState(uf) {
    if (!uf) return SALES_TEAMS['REGIANE'].phone; // Fallback

    // Procura em qual time o estado está
    for (const [name, data] of Object.entries(SALES_TEAMS)) {
        if (data.states.includes(uf)) {
            console.log(`Estado ${uf} detectado. Redirecionando para ${name}`);
            return data.phone;
        }
    }
    
    return SALES_TEAMS['REGIANE'].phone; // Se não achar (ex: estado novo?), vai pro padrão
}

function setupWhatsAppRouting() {
    const btnWa = document.getElementById('btn-whatsapp');
    
    if (btnWa) {
        btnWa.addEventListener('click', async (e) => {
            e.preventDefault(); // Impede abrir o link vazio imediatamente
            
            const originalText = btnWa.innerHTML;
            btnWa.innerHTML = '<i class="fas fa-satellite-dish fa-spin"></i> Localizando Vendedor...';
            
            // Mensagem salva no dataset (definida na função updateHydraulicsDisplay)
            const message = btnWa.dataset.msg || "Olá, gostaria de um orçamento.";
            
            // Callback de Sucesso
            const onSuccess = async (position) => {
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                
                const uf = await getStateFromCoords(lat, lon);
                const phone = getSalesPhoneByState(uf);
                
                window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
                btnWa.innerHTML = originalText;
            };

            // Callback de Erro (Negou permissão ou erro técnico) -> Vai pra Regiane
            const onError = () => {
                console.warn("Geolocalização negada ou falhou. Usando padrão.");
                const phone = SALES_TEAMS['REGIANE'].phone;
                window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
                btnWa.innerHTML = originalText;
            };

            // Solicita Posição
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(onSuccess, onError, { timeout: 5000 });
            } else {
                onError();
            }
        });
    }
}

// =============================================================================
// 2. ESTADO GLOBAL
// =============================================================================

let elements = [];
let selectedElementId = null;
let poolInputMode = 'dim'; 
let roofRotation = 0;

let toolSettings = { roofFaces: 1, poolShape: 'rectangular', poolDepth: 1.40 };

const canvas = document.getElementById('canvas');
const inputs = {
    roofLength: document.getElementById('roof-length'),
    roofWidth: document.getElementById('roof-width'),
    poolLength: document.getElementById('pool-length'),
    poolWidth: document.getElementById('pool-width'),
    climate: document.getElementById('climate-select'),
    usage: document.getElementById('usage-select'),
    poolDepth: document.getElementById('pool-depth'),
    poolVolume: document.getElementById('pool-volume')
};

// =============================================================================
// 3. CLASSE CANVAS ELEMENT
// =============================================================================

class CanvasElement {
    constructor(type, length, width, x, y) {
        this.id = type; // Usando 'roof' ou 'pool' como ID único
        this.type = type;
        this.length = parseFloat(length);
        this.width = parseFloat(width);
        this.x = x;
        this.y = y;
        this.rotation = 0;
        
        // Copia as configurações atuais
        this.config = { 
            roofFaces: toolSettings.roofFaces, 
            poolShape: toolSettings.poolShape, 
            poolDepth: parseFloat(inputs.poolDepth.value) || 1.40 
        };
        
        if (type === 'roof') {
            this.rotation = roofRotation; // Pega o estado global
        }

        this.el = document.createElement('div');
        this.el.id = this.id;
        this.render();
        this.attachEvents();
    }

    getArea() {
        if (this.type === 'pool' && this.config.poolShape === 'circular') {
            const radius = this.length / 2;
            return Math.PI * radius * radius;
        }
        return this.length * this.width;
    }

    getOrientation() {
        const deg = this.rotation % 360;
        if (deg === 0) return 'NORTE';
        if (deg === 90) return 'LESTE';
        if (deg === 180) return 'SUL';
        if (deg === 270) return 'OESTE';
        return getOrientationFromRotation(this.rotation);
    }

    drawSolarArrays(option, safeFall, safeLength) {
        if (this.type !== 'roof') return;
        const oldLayer = this.el.querySelector('.solar-layer');
        if (oldLayer) oldLayer.remove();
        
        // Se a opção selecionada não couber, não desenha.
        if (!option || !option.fits) return;

        const layer = document.createElement('div');
        layer.className = 'solar-layer';

        const m = MARGIN_SAFETY * PIXELS_PER_METER;
        const gap = BATTERY_GAP * PIXELS_PER_METER;
        const colH = option.col.len * PIXELS_PER_METER;
        const colW = option.col.width * PIXELS_PER_METER;

        const orientation = this.getOrientation();
        const faces = this.config.roofFaces;
        
        let zones = [];
        const fullW_px = this.length * PIXELS_PER_METER;
        const fullH_px = this.width * PIXELS_PER_METER;
        let halfH = fullH_px / 2;
        let zoneW, zoneH;

        if (orientation === 'LESTE' || orientation === 'OESTE') {
            zoneW = fullH_px - (2 * m); 
            zoneH = fullW_px - (2 * m); 
        } else {
            zoneW = fullW_px - (2 * m); 
            zoneH = fullH_px - (2 * m); 
        }

        if (faces === 1) {
            zones.push({ top: m, left: m, h: zoneH, w: zoneW, side: orientation });
        } else if (faces === 2) {
            if (orientation === 'LESTE' || orientation === 'OESTE') {
                const topSide = (orientation === 'LESTE') ? 'LESTE' : 'OESTE';
                const bottomSide = (orientation === 'LESTE') ? 'OESTE' : 'LESTE';
                zones.push({ top: m, left: m, h: halfH - m, w: zoneW, side: topSide });
                zones.push({ top: halfH + m, left: m, h: halfH - m, w: zoneW, side: bottomSide });
            } else {
                const usefulFace = (orientation === 'NORTE') ? 'NORTE' : null;
                if (usefulFace) {
                    zones.push({ top: m, left: m, h: halfH - m, w: zoneW, side: usefulFace });
                }
            }
        }
        
        let platesTotal = option.realQty;
        let platesDistributed = 0;
        const distribution = this.solarData.distribution;
        
        let targetLeste = 0;
        let targetOeste = 0;

        if (distribution) {
            targetLeste = Math.ceil(platesTotal * DISTRIBUTION_L_O.LESTE);
            targetOeste = platesTotal - targetLeste;
        }


        zones.forEach((zone, zIndex) => {
            let zoneTargetQty;
            
            if (distribution) {
                if (zone.side === 'LESTE') zoneTargetQty = targetLeste;
                else if (zone.side === 'OESTE') zoneTargetQty = targetOeste;
                else zoneTargetQty = platesTotal; 
            } else {
                if (zIndex === 0) zoneTargetQty = Math.ceil(platesTotal / option.totalUsefulFaces);
                else zoneTargetQty = platesTotal - platesDistributed;
            }
            
            if (zoneTargetQty <= 0) return;
            // Se esta zona é o lado NORTE, e estamos em 2 águas, ajustamos a quantidade
            if (faces === 2 && orientation === 'NORTE' && zIndex === 0) {
                 // Apenas 50% da área, então a quantidade já deve ser ajustada
            }
            
            platesDistributed += zoneTargetQty;

            const rowsAvailable = option.rowsPerFace || 1;
            const platesPerVerticalRow = Math.ceil(zoneTargetQty / rowsAvailable);
            
            for (let v = 0; v < rowsAvailable; v++) {
                let platesInThisRow = platesPerVerticalRow;
                const drawnInZone = v * platesPerVerticalRow;
                const remaining = zoneTargetQty - drawnInZone;

                if(remaining <= 0) break;
                if(remaining < platesInThisRow) platesInThisRow = remaining;

                const numBatteries = Math.ceil(platesInThisRow / MAX_PLATES_PER_BATTERY);
                const avgPerBattery = Math.floor(platesInThisRow / numBatteries);
                let remainder = platesInThisRow % numBatteries;

                let cursorX = zone.left;
                let cursorY = zone.top + (v * (colH + gap)); 

                for(let i=0; i<numBatteries; i++) {
                    let size = avgPerBattery + (remainder > 0 ? 1 : 0);
                    if (remainder > 0) remainder--;
                    
                    if (size === 0) continue; 

                    const batWidth = size * colW;
                    
                    const rowEl = document.createElement('div');
                    rowEl.className = 'solar-row';
                    rowEl.style.height = `${colH}px`;
                    rowEl.style.width = `${batWidth}px`;
                    rowEl.style.left = `${cursorX}px`;
                    rowEl.style.top = `${cursorY}px`;
                    rowEl.style.backgroundSize = `${colW}px 100%`; 
                    rowEl.innerHTML = `<span class="row-label">${size} un</span>`;
                    layer.appendChild(rowEl);

                    cursorX += batWidth + gap;
                }
            }
        });

        this.el.appendChild(layer);
    }

    render() {
        const pxW = this.length * PIXELS_PER_METER; 
        const pxH = this.width * PIXELS_PER_METER;

        this.el.style.width = `${pxW}px`;
        this.el.style.height = `${pxH}px`;
        // Posição (recalculada ou mantida se já existir)
        const posX = this.x || (this.type === 'roof' ? (isMobile ? 20 : 100) : (isMobile ? 50 : 150));
        const posY = this.y || (this.type === 'roof' ? (isMobile ? 20 : 100) : (isMobile ? 150 : 250));
        
        this.el.style.left = `${posX}px`;
        this.el.style.top = `${posY}px`;
        this.el.style.transform = `rotate(${this.rotation}deg)`;
    
        this.el.className = `element ${this.type}`;
        if (this.type === 'pool') this.el.classList.add(this.config.poolShape);
        if (this.id == selectedElementId) this.el.classList.add('selected');
        
        // Remove elementos antigos antes de renderizar novos
        this.el.innerHTML = '';
    
        let innerHTML = '';
        
        if (this.type === 'roof') {
            const orientation = this.getOrientation();
            const faces = this.config.roofFaces;
            // Cor da seta: Vermelha se SUL, ou se 2 águas e face principal não é N/L/O (ex: SUL)
            const isSouth = (faces === 1 && orientation === 'SUL') || (faces === 2 && (orientation === 'SUL' || (orientation !== 'NORTE' && this.rotation % 360 === 180))); 
            const arrowColor = isSouth ? '#ff0000' : 'white';
            
            innerHTML += `<div class="direction-arrow" style="border-bottom-color: ${arrowColor}"></div>
                          <div class="orientation-label" style="color:${arrowColor}">${orientation}</div>`;
            
            if (faces === 2) {
                innerHTML += `<div class="roof-divider horizontal"></div>`;
                const halfWidth = (this.width / 2).toFixed(2);
                innerHTML += `<div class="ruler-text top-half">${halfWidth}m</div>
                              <div class="ruler-text bottom-half">${halfWidth}m</div>`;
    
                // Se Norte (rotação 0), a parte de baixo é Sul e deve ser marcada
                if (orientation === 'NORTE') innerHTML += `<div class="bad-zone bottom-half" data-text="SUL"></div>`;
                // Se Sul (rotação 180), a parte de cima é Sul e deve ser marcada
                if (orientation === 'SUL' || this.rotation % 360 === 180) innerHTML += `<div class="bad-zone top-half" data-text="SUL"></div>`; 

            }
            
            innerHTML += `<div class="margin-box"></div>`;
        }
        
        let extraInfo = '';
        if(this.type === 'pool') extraInfo = `<br>Prof: ${this.config.poolDepth}m`;
    
        innerHTML += `<div class="element-info">
            <strong>${this.type === 'roof' ? 'TELHADO' : 'PISCINA'}</strong><br>
            ${this.length.toFixed(2)}m x ${this.width.toFixed(2)}m${extraInfo}
        </div>`;
    
        this.el.innerHTML = innerHTML;
    
        if (this.solarData && this.type === 'roof' && this.solarData.selectedOption) {
            setTimeout(() => this.drawSolarArrays(this.solarData.selectedOption, this.solarData.h, this.solarData.w), 0);
        }
    }

    attachEvents() {
        // Usa o ID como "roof" ou "pool"
        this.el.addEventListener('mousedown', (e) => {
            e.stopPropagation(); selectElement(this.id); startDrag(e, this);
        });
        this.el.addEventListener('touchstart', (e) => {
            e.stopPropagation(); selectElement(this.id);
            const t = e.touches[0];
            startDrag({ clientX: t.clientX, clientY: t.clientY, type: 'touchstart', preventDefault: ()=>{} }, this);
        }, { passive: false });
    }
}

// =============================================================================
// 4. LÓGICA DE SELEÇÃO E CÁLCULO
// =============================================================================

function generateWhatsAppMessage(option, poolArea, safeLength, safeFall) {
    if (!option || !option.fits) {
        const poolAreaText = poolArea.toFixed(1);
        const requiredAreaText = parseFloat(document.getElementById('res-required-area').textContent).toFixed(1);
        const roofDimsText = `${safeLength.toFixed(1)}m x ${safeFall.toFixed(1)}m`;
        
        return `Olá, eu cotei que minha piscina (Área: ${poolAreaText}m²) precisaria de ${requiredAreaText}m² de coletores, mas não tenho tamanho suficiente no meu telhado (Dimensões Úteis: ${roofDimsText}). Você teria alguma outra indicação melhor?`;
    }
    
    const connectionType = document.getElementById('connection-type').value;
    // O VQV é calculado como Baterias / 3 (série) ou Baterias (paralelo)
    let vqvCount = (connectionType === 'series') ? Math.ceil(option.batteries / 3) : option.batteries;

    return `Olá, solicito orçamento:
*Projeto TS Solar*
---------------------------
- Piscina: ${poolArea.toFixed(1)}m²
- Telhado Útil: ${safeLength.toFixed(1)}m x ${safeFall.toFixed(1)}m
- Demanda Térmica: ${parseFloat(document.getElementById('res-required-area').textContent).toFixed(1)}m²

*Materiais Selecionados:*
- ${option.purchaseQty} ${option.col.name} (Qtd Real: ${option.realQty})
- ${option.batteries} Kits de Fechamento
- ${vqvCount} Válvulas Quebra-Vácuo (VQV)`;
}

function updateHydraulicsDisplay(option) {
    const roof = elements.find(e => e.type === 'roof');
    if (!roof || !roof.solarData) return;

    if (option && option.fits) {
        const connectionType = document.getElementById('connection-type').value;
        let vqvCount = (connectionType === 'series') ? Math.ceil(option.batteries / 3) : option.batteries;
        const kitsCount = option.batteries;

        document.getElementById('best-option-title').innerHTML = `<i class="fas fa-check-circle"></i> Opção Selecionada: ${option.col.name}`;
        document.getElementById('res-batteries').textContent = option.batteries;
        document.getElementById('res-kits').textContent = kitsCount;
        document.getElementById('res-vqv').textContent = vqvCount;
        
        // Atualiza a visualização das placas no telhado
        roof.drawSolarArrays(option, roof.solarData.h, roof.solarData.w);

    } else {
        document.getElementById('best-option-title').innerHTML = `<i class="fas fa-times-circle"></i> Opção Selecionada: Não cabe no telhado.`;
        ['res-batteries', 'res-kits', 'res-vqv'].forEach(id => document.getElementById(id).textContent = '-');
        // Se a opção selecionada não cabe, remove a visualização
        const l = roof.el.querySelector('.solar-layer');
        if(l) l.remove();
    }
    
    // ATUALIZA O WHATSAPP COM A MENSAGEM DO COLETOR SELECIONADO/RECOMENDADO
    const btnWa = document.getElementById('btn-whatsapp');
    btnWa.dataset.msg = generateWhatsAppMessage(
        option, 
        roof.solarData.poolArea, 
        roof.solarData.w, 
        roof.solarData.h
    );
}

function handleCollectorSelection(event) {
    const row = event.currentTarget;
    const collectorName = row.dataset.collectorName;
    
    const roof = elements.find(e => e.type === 'roof');
    if (!roof || !roof.solarData || !roof.solarData.allOptions[collectorName]) return;
    
    // 1. Remove seleção anterior
    document.querySelectorAll('#collectors-tbody tr').forEach(tr => {
        tr.classList.remove('row-selected');
    });
    
    // 2. Adiciona seleção atual
    row.classList.add('row-selected');
    
    const selectedOption = roof.solarData.allOptions[collectorName];

    // 3. Atualiza o estado da seleção e a exibição
    roof.solarData.selectedOption = selectedOption;
    updateHydraulicsDisplay(selectedOption);
}

function configureElements() {
    // 1. Validar e Capturar dados do Telhado
    const lenR = parseFloat(inputs.roofLength.value);
    const widR = parseFloat(inputs.roofWidth.value);
    if (!lenR || !widR || lenR <= 0 || widR <= 0) {
        alert("Por favor, preencha as dimensões válidas do Telhado.");
        return;
    }

    // 2. Validar e Capturar dados da Piscina
    let lenP, widP;
    let poolArea = 0;
    
    // Captura a profundidade primeiro, pois é usada em ambos os modos
    const poolDepth = parseFloat(inputs.poolDepth.value) || 1.40;
    
    if (poolInputMode === 'vol') {
        const volumeL = parseFloat(inputs.poolVolume.value);
        if (!volumeL || volumeL <= 0) {
            alert("Informe um volume válido para a piscina.");
            return;
        }
        poolArea = volumeL / 1000 / poolDepth;
        
        if (toolSettings.poolShape === 'circular') {
            const radius = Math.sqrt(poolArea / Math.PI);
            lenP = radius * 2; widP = radius * 2;
        } else {
            const side = Math.sqrt(poolArea);
            lenP = side; widP = side; // Aproxima retangular por quadrado
        }

    } else { // Modo Medidas (dim)
        lenP = parseFloat(inputs.poolLength.value);
        widP = parseFloat(inputs.poolWidth.value);
        if (!lenP || !widP || lenP <= 0 || widP <= 0) {
            alert("Por favor, preencha as dimensões válidas da Piscina.");
            return;
        }
    }
    
    // 3. Atualizar/Criar Elementos
    
    const pxLenR = lenR * PIXELS_PER_METER; 
    const pxLenP = lenP * PIXELS_PER_METER;
    const canvasW = canvas.clientWidth;
    
    let roofIndex = elements.findIndex(e => e.type === 'roof');
    let poolIndex = elements.findIndex(e => e.type === 'pool');
    
    let roofEl;
    let poolEl;
    
    // POSICIONAMENTO E CRIAÇÃO DO TELHADO
    if (roofIndex === -1) {
        const roofY = MIN_SEPARATION_PX; 
        const roofX = (canvasW / 2) - (pxLenR / 2);

        roofEl = new CanvasElement('roof', lenR, widR, roofX, roofY);
        elements.push(roofEl);
        canvas.appendChild(roofEl.el);
    } else {
        roofEl = elements[roofIndex];
        roofEl.length = lenR;
        roofEl.width = widR;
        roofEl.config.roofFaces = toolSettings.roofFaces;
        roofEl.config.poolDepth = poolDepth; 
        roofEl.rotation = roofRotation; 
        roofEl.render();
    }
    
    // POSICIONAMENTO E CRIAÇÃO DA PISCINA
    if (poolIndex === -1) {
        const poolY = (roofEl.y || MIN_SEPARATION_PX) + (roofEl.width * PIXELS_PER_METER) + MIN_SEPARATION_PX;
        const poolX = (canvasW / 2) - (pxLenP / 2); 

        poolEl = new CanvasElement('pool', lenP, widP, poolX, poolY);
        elements.push(poolEl);
        canvas.appendChild(poolEl.el);
    } else {
        poolEl = elements[poolIndex];
        poolEl.length = lenP;
        poolEl.width = widP;
        poolEl.config.poolShape = toolSettings.poolShape;
        poolEl.config.poolDepth = poolDepth;
        poolEl.render();
    }
    
    updateCounters();
    
    // 4. Dispara o cálculo e a exibição
    calculateAndDisplayResults(); 
}

function calculateAndDisplayResults() {
    
    document.getElementById('calculation-master-group').style.display = 'block';

    const resultsContainer = document.getElementById('solar-results');
    const tableBody = document.getElementById('collectors-tbody');
    
    const pool = elements.find(e => e.type === 'pool');
    const roof = elements.find(e => e.type === 'roof');

    if (!pool || !roof) return;
    
    // Limpa a visualização de placas antigas
    elements.forEach(e => { 
        if(e.type === 'roof') {
            const l = e.el.querySelector('.solar-layer');
            if(l) l.remove();
        }
    });

    const orientation = roof.getOrientation();
    const faces = roof.config.roofFaces;
    
    // CÁLCULO TÉRMICO
    const climate = inputs.climate.value;
    const usage = inputs.usage.value;
    
    let poolBaseArea = pool.getArea();
    let isPrainha = false;
    if (pool.config.poolDepth < 0.70) {
        poolBaseArea = poolBaseArea * 1.30; 
        isPrainha = true;
    }

    const factorClimate = FACTOR_MATRIX[usage][climate];

    let factorFace;
    let totalUsefulFaces = 1;
    
    if (faces === 2 && (orientation === 'LESTE' || orientation === 'OESTE')) {
        factorFace = ORIENTATION_FACTORS['LESTE']; 
        totalUsefulFaces = 2;
    } else {
        factorFace = ORIENTATION_FACTORS[orientation];
        if (factorFace === null) factorFace = 1.6; 
    }

    const requiredPlateArea = poolBaseArea * factorClimate * factorFace;

    // GEOMETRIA DO TELHADO
    const realLength = roof.length;
    const realWidth = roof.width;
    
    let safeFall = 0; 
    let safeLength = 0; 
    
    if (orientation === 'LESTE' || orientation === 'OESTE') {
        safeFall = Math.max(0, realWidth - (MARGIN_SAFETY * 2));
        safeLength = Math.max(0, realLength - (MARGIN_SAFETY * 2));
    } else {
        safeFall = Math.max(0, realWidth - (MARGIN_SAFETY * 2));
        safeLength = Math.max(0, realLength - (MARGIN_SAFETY * 2));
    }

    if (faces === 2) {
        const halfWidth = realWidth / 2;
        safeFall = Math.max(0, halfWidth - (MARGIN_SAFETY * 2)); 
    }
    
    if (safeFall <= 0 || safeLength <= 0) {
        alert("As margens de segurança (0.5m) tornam o telhado inutilizável para placas. Reduza a margem ou use um telhado maior.");
        resultsContainer.style.display = 'block';
        tableBody.innerHTML = `<tr><td colspan="4" style="color:${window.VAR_DANGER_COLOR};">Telhado muito pequeno após margem de segurança.</td></tr>`;
        
        // Se falhar, reseta o WhatsApp para mensagem de falha
        const fallbackOption = { fits: false };
        const btnWa = document.getElementById('btn-whatsapp');
        btnWa.dataset.msg = generateWhatsAppMessage(fallbackOption, poolBaseArea, realLength, realWidth);
        btnWa.style.display = 'flex';
        return;
    }


    // INVENTÁRIO (LOOP DE COLETORES)
    let bestOption = null;
    let htmlRows = '';
    let foundFits = false;
    
    const allCollectorOptions = {}; 

    COLLECTORS.forEach(col => {
        const realQtyNeeded = Math.ceil(requiredPlateArea / col.area);
        const rowsPerFace = Math.floor(safeFall / col.len);
        
        let fits = false;
        let fittingDetails = "";
        let finalBatteries = 0;
        let invadesMargin = false; 
        
        if (rowsPerFace < 1) {
            fittingDetails = "Muito comprido (não cabe na caída)";
        } else {
            const totalRowsAvailable = rowsPerFace * totalUsefulFaces;
            
            // Distribuição e Espaço
            let maxPlatesInRow;
            if (totalUsefulFaces === 2) {
                const platesLeste = Math.ceil(realQtyNeeded * DISTRIBUTION_L_O.LESTE);
                const platesOeste = realQtyNeeded - platesLeste;
                const qtyToFit = Math.max(platesLeste, platesOeste);
                maxPlatesInRow = Math.ceil(qtyToFit / rowsPerFace); 
            } else {
                maxPlatesInRow = Math.ceil(realQtyNeeded / totalRowsAvailable);
            }
            
            const batsInRow = Math.ceil(maxPlatesInRow / MAX_PLATES_PER_BATTERY);
            const widthNeeded = (maxPlatesInRow * col.width) + ((batsInRow - 1) * BATTERY_GAP);
            
            if (widthNeeded <= safeLength) {
                fits = true;
                invadesMargin = false;
            } else {
                fits = false;
            }

            if (fits) {
                foundFits = true;
                // Cálculo de Baterias Físicas
                let totalBats = 0;
                
                if (totalUsefulFaces === 2) {
                    const qtyLeste = Math.ceil(realQtyNeeded * DISTRIBUTION_L_O.LESTE);
                    const qtyOeste = realQtyNeeded - qtyLeste;
                    
                    const calcFaceBatteries = (qty, rows) => {
                        let bats = 0;
                        let left = qty;
                        for(let r=0; r<rows; r++) {
                            let inRow = Math.ceil(left / (rows - r)); 
                            left -= inRow;
                            bats += Math.ceil(inRow / MAX_PLATES_PER_BATTERY);
                            if (left < 0) left = 0;
                        }
                        return bats;
                    };
                    totalBats += calcFaceBatteries(qtyLeste, rowsPerFace);
                    totalBats += calcFaceBatteries(qtyOeste, rowsPerFace);

                } else {
                    let platesLeft = realQtyNeeded;
                    for(let i=0; i<totalRowsAvailable; i++) {
                        let p = Math.ceil(platesLeft / (totalRowsAvailable - i));
                        platesLeft -= p;
                        totalBats += Math.ceil(p / MAX_PLATES_PER_BATTERY);
                        if (platesLeft < 0) platesLeft = 0;
                    }
                }
                finalBatteries = totalBats;
                fittingDetails = `${finalBatteries} Baterias (Ideal)`;
            } else {
                if (!fittingDetails) fittingDetails = "Telhado estreito (falta largura útil)";
            }
        }

        const purchaseQty = Math.ceil(realQtyNeeded / 10) * 10;
        
        const currentResult = { 
            col, 
            realQty: realQtyNeeded, 
            purchaseQty, 
            batteries: finalBatteries, 
            rowsPerFace, 
            totalUsefulFaces, 
            invadesMargin, 
            fits: fits,
            fittingDetails: fittingDetails
        };
        allCollectorOptions[col.name] = currentResult;

        
        // Lógica de seleção do bestOption (Prioriza o que cabe e tem menor Qtd)
        if (fits && (!bestOption || !bestOption.fits || realQtyNeeded < bestOption.realQty)) {
            bestOption = currentResult;
        } else if (!foundFits && (!bestOption || realQtyNeeded < bestOption.realQty)) {
            bestOption = currentResult; // Se nada cabe, apenas mostra o menor requerido
        }

        const isCurrentlyRecommended = (bestOption && bestOption.col.name === col.name && bestOption.fits);
        
        const rowClass = isCurrentlyRecommended ? 'row-recommended' : '';
        const statusText = fits ? 'CABE' : 'NÃO';
        const statusClass = fits ? 'status-ok' : 'status-error';

        htmlRows += `
            <tr class="${rowClass}" data-collector-name="${col.name}">
                <td><strong>${col.name}</strong>${isCurrentlyRecommended ? '<span class="badge-best">RECOMENDADO</span>' : ''}</td>
                <td><strong>${realQtyNeeded}</strong></td>
                <td>${fits ? finalBatteries : '-'}</td>
                <td class="${statusClass}">
                    ${statusText} <br>
                    <span style="font-size:0.7em; color:#666">${fittingDetails}</span>
                </td>
            </tr>
        `;
    });

    tableBody.innerHTML = htmlRows;
    document.getElementById('res-pool-area').textContent = poolBaseArea.toFixed(1);
    document.getElementById('res-roof-dims').textContent = `${safeLength.toFixed(1)}x${safeFall.toFixed(1)}`;
    document.getElementById('res-required-area').textContent = requiredPlateArea.toFixed(1);
    
    const alertEl = document.getElementById('prainha-alert');
    if(alertEl) alertEl.style.display = isPrainha ? 'block' : 'none';
    
    // =========================================================================
    // ARMAZENA DADOS E INICIALIZA SELEÇÃO
    // =========================================================================
    
    // Salva todos os dados calculados no elemento do telhado
    roof.solarData = { 
        bestOption: bestOption, 
        selectedOption: bestOption, 
        allOptions: allCollectorOptions, 
        h: safeFall, 
        w: safeLength, 
        poolArea: poolBaseArea,
        orientation: orientation,
        distribution: totalUsefulFaces === 2 ? DISTRIBUTION_L_O : null
    };

    if (bestOption && bestOption.fits) {
        // Inicializa a exibição hidráulica e visual com a melhor opção
        updateHydraulicsDisplay(bestOption);
        
        // Marca a linha do coletor recomendado como selecionada
        const bestRow = tableBody.querySelector(`tr[data-collector-name="${bestOption.col.name}"]`);
        if(bestRow) bestRow.classList.add('row-selected');
    } else {
        // Caso de falha total, exibe a mensagem de falha e zera a hidráulica
        updateHydraulicsDisplay(null); 
    }
    
    // ANEXA O EVENTO DE CLIQUE ÀS LINHAS
    document.querySelectorAll('#collectors-tbody tr').forEach(row => {
        row.addEventListener('click', handleCollectorSelection);
        row.style.cursor = 'pointer'; 
    });


    // Exibe o botão do WhatsApp (a mensagem já está setada em updateHydraulicsDisplay)
    const btnWa = document.getElementById('btn-whatsapp');
    if(btnWa) {
        btnWa.href = "#"; 
        btnWa.style.display = 'flex';
    }
    
    resultsContainer.style.display = 'block';
    if(isMobile) setTimeout(() => resultsContainer.scrollIntoView({ behavior: 'smooth' }), 100);
}


// =============================================================================
// 5. EVENTOS E UTILITÁRIOS
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    
    // Variável para ter acesso ao CSS
    window.VAR_DANGER_COLOR = getComputedStyle(document.documentElement).getPropertyValue('--danger-color').trim();

    function updateInputVisibility(mode) {
        const dimsContainer = document.getElementById('pool-dim-inputs');
        const volContainer = document.getElementById('vol-input-group');
    
        if (mode === 'vol') {
            dimsContainer.style.display = 'none'; 
            volContainer.style.display = 'grid'; 
        } else {
            dimsContainer.style.display = 'grid'; 
            volContainer.style.display = 'none'; 
        }
    }

    function setPoolInputMode(mode) {
        poolInputMode = mode;
        document.querySelectorAll('.mode-btn').forEach(b => {
            if(b.dataset.mode === mode) b.classList.add('active');
            else b.classList.remove('active');
        });
        updateInputVisibility(mode);
    }

    // AÇÃO PRINCIPAL: CONCLUIR CONFIGURAÇÃO
    document.getElementById('configure-elements').addEventListener('click', configureElements);

    // BOTÕES DE MODO
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => setPoolInputMode(btn.dataset.mode));
    });

    // BOTÕES DE FORMATO
    document.querySelectorAll('.shape-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            toolSettings.poolShape = btn.dataset.shape;

            const btnMedidas = document.querySelector('.mode-btn[data-mode="dim"]');
            if (toolSettings.poolShape === 'circular') {
                if(btnMedidas) btnMedidas.style.display = 'none';
                setPoolInputMode('vol'); // Circular é forçado ao volume
            } else {
                if(btnMedidas) btnMedidas.style.display = 'inline-block'; 
                setPoolInputMode('dim');
            }
        });
    });

    // BOTÕES DE FACES
    document.querySelectorAll('.face-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.face-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            toolSettings.roofFaces = parseInt(btn.dataset.faces);
        });
    });
    
    // ATUALIZAÇÃO DO CÁLCULO AO MUDAR CLIMA/USO
    document.getElementById('climate-select').addEventListener('change', calculateAndDisplayResults);
    document.getElementById('usage-select').addEventListener('change', calculateAndDisplayResults);
    document.getElementById('connection-type').addEventListener('change', () => {
        // Recalcula para atualizar o VQV se já houver uma opção selecionada
        const roof = elements.find(e => e.type === 'roof');
        if (roof && roof.solarData && roof.solarData.selectedOption) {
             updateHydraulicsDisplay(roof.solarData.selectedOption);
        }
    });

    // ROTAÇÃO
    const btnLeft = document.getElementById('rotate-left');
    const btnRight = document.getElementById('rotate-right');
    if(btnLeft) btnLeft.addEventListener('click', () => rotateSelected('left'));
    if(btnRight) btnRight.addEventListener('click', () => rotateSelected('right'));
    
    
    // AÇÕES DO PAINEL DE SELEÇÃO
    document.getElementById('delete-selected').addEventListener('click', deleteSelected);
    document.getElementById('delete-all').addEventListener('click', () => {
        if(confirm('Limpar tudo? Telhado e Piscina serão removidos do projeto.')) {
            canvas.innerHTML = ''; elements = []; selectedElementId = null;
            document.getElementById('selection-panel').style.display = 'none';
            document.getElementById('calculation-master-group').style.display = 'none'; 
            updateCounters();
        }
    });

    // SELEÇÃO
    canvas.addEventListener('mousedown', (e) => { if (e.target === canvas) deselectAll(); });
    canvas.addEventListener('touchstart', (e) => { if (e.target === canvas) deselectAll(); });
	setupWhatsAppRouting();
    
    // Inicialização do estado de visibilidade
    updateInputVisibility(poolInputMode);
    
    // Inicializa o display de orientação ao carregar
    updateOrientationDisplay(getOrientationFromRotation(roofRotation));
});

function deselectAll() {
    selectedElementId = null;
    elements.forEach(el => el.el.classList.remove('selected'));
    document.getElementById('selection-panel').style.display = 'none';
}

function selectElement(id) {
    selectedElementId = id;
    elements.forEach(el => el.render());
    const el = elements.find(e => e.id === id);
    const panel = document.getElementById('selection-panel');
    if (el) {
        panel.style.display = 'block';
        
        const typeDisplay = (el.type === 'roof' ? 'TELHADO' : 'PISCINA');
        document.getElementById('sel-type').textContent = typeDisplay;
        
        document.getElementById('sel-area').textContent = el.getArea().toFixed(2);
        
        const usefulInfo = document.getElementById('info-useful-area');
        if(el.type === 'roof') {
            usefulInfo.style.display = 'block';
            const usefulLength = Math.max(0, el.length - (MARGIN_SAFETY * 2));
            const usefulWidth = Math.max(0, el.width - (MARGIN_SAFETY * 2));
            document.getElementById('sel-useful-area').textContent = (usefulLength * usefulWidth).toFixed(2);
            updateOrientationDisplay(el.getOrientation());
        } else {
            usefulInfo.style.display = 'none';
        }
    }
}

function rotateSelected(dir) {
    let el = elements.find(e => e.id === selectedElementId && e.type === 'roof');
    if (!el) {
        el = elements.find(e => e.type === 'roof');
    }

    // 1. Atualiza a rotação de estado
    roofRotation += (dir === 'left' ? -90 : 90);
    if (roofRotation < 0) roofRotation += 360;
    roofRotation = roofRotation % 360; 

    // 2. Se o elemento existe no canvas, atualiza-o
    if (el) {
        el.rotation = roofRotation;
        el.render();
        if (el.solarData) {
            // Se houver dados solares, recalcula o dimensionamento e a visualização
            calculateAndDisplayResults(); 
        }
    }
    
    // 3. ATUALIZA O DISPLAY (SEMPRE)
    updateOrientationDisplay(getOrientationFromRotation(roofRotation));
}

function getOrientationFromRotation(rotationDeg) {
    const deg = rotationDeg % 360;
    if (deg === 0) return 'NORTE';
    if (deg === 90) return 'LESTE';
    if (deg === 180) return 'SUL';
    if (deg === 270) return 'OESTE';
    return 'NORTE';
}

function updateOrientationDisplay(txt) {
    const d = document.getElementById('current-orientation-display');
    if(d) {
        d.textContent = txt;
        
        const roof = elements.find(e => e.type === 'roof');
        let isBad = false;
        if(roof) {
            const faces = roof.config.roofFaces;
            const deg = roof.rotation % 360;
            if (faces === 1 && txt === 'SUL') isBad = true;
            if (faces === 2 && (txt === 'SUL' || deg === 180)) isBad = true; 
        }

        d.style.color = isBad ? window.VAR_DANGER_COLOR : '#333';
    }
}

function deleteSelected() {
    if (!selectedElementId) return;
    const idx = elements.findIndex(e => e.id === selectedElementId);
    if (idx > -1) {
        elements[idx].el.remove();
        elements.splice(idx, 1);
        deselectAll();
        updateCounters();
        
        if (elements.length === 0) {
            document.getElementById('selection-panel').style.display = 'none';
            document.getElementById('calculation-master-group').style.display = 'none'; 
        }
    }
}

function startDrag(e, canvasEl) {
    const startX = e.clientX || (e.touches && e.touches[0].clientX);
    const startY = e.clientY || (e.touches && e.touches[0].clientY);
    
    const elemX = canvasEl.x;
    const elemY = canvasEl.y;

    const container = document.getElementById('canvas');
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    const elW = canvasEl.length * PIXELS_PER_METER;
    const elH = canvasEl.width * PIXELS_PER_METER;

    function onMove(ev) {
        let cx = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX;
        let cy = ev.type === 'touchmove' ? ev.touches[0].clientY : ev.clientY;
        
        if(ev.type === 'touchmove') ev.preventDefault(); 
        
        let newX = elemX + (cx - startX);
        let newY = elemY + (cy - startY);

        if (newX < 0) newX = 0;
        if (newY < 0) newY = 0;
        if (newX + elW > containerW) newX = containerW - elW;
        if (newY + elH > containerH) newY = containerH - elH;

        canvasEl.x = newX;
        canvasEl.y = newY;
        canvasEl.render();
    }
    
    function onEnd() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
    }
    
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
}

function updateCounters() {
    document.getElementById('roof-count').textContent = elements.filter(e => e.type === 'roof').length;
    document.getElementById('pool-count').textContent = elements.filter(e => e.type === 'pool').length;
}

// BÚSSOLA
const compassEl = document.querySelector('.compass-overlay');
const btnCompass = document.getElementById('btn-compass-start');
const isIOS = navigator.userAgent.match(/(iPod|iPhone|iPad)/) && navigator.userAgent.match(/AppleWebKit/);

if (isIOS) {
    btnCompass.style.display = 'block';
    btnCompass.addEventListener('click', () => {
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission().then(resp => {
                if (resp === 'granted') {
                    window.addEventListener('deviceorientation', handleIOS);
                    btnCompass.style.display = 'none';
                }
            }).catch(alert);
        }
    });
} else {
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', handleAndroid);
    else window.addEventListener('deviceorientation', handleAndroid);
}

function handleIOS(e) { rotateCompass(e.webkitCompassHeading); }
function handleAndroid(e) {
    let heading = e.webkitCompassHeading || (e.alpha ? 360 - e.alpha : null);
    if (heading !== null) rotateCompass(heading);
}
function rotateCompass(deg) { compassEl.style.transform = `translateY(0) rotate(-${deg}deg)`; }