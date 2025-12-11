/* 
    SISTEMA DE DIMENSIONAMENTO SOLAR - PRO ENGINEERING
    Versão: 7.0 (Clean: Litragem + Leste/Oeste 60/40 - Sem Obstruções)
*/

// =============================================================================
// 1. CONFIGURAÇÕES & TABELAS DE ENGENHARIA
// =============================================================================

const isMobile = window.innerWidth < 768;
const PIXELS_PER_METER = isMobile ? 22 : 40; 

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
            
            // Mensagem salva no dataset (definida na função calculateSolarSystem)
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
let currentToolType = 'roof';
let poolInputMode = 'dim'; 

let toolSettings = { roofFaces: 1, poolShape: 'rectangular', poolDepth: 1.40 };

const canvas = document.getElementById('canvas');
const inputs = {
    length: document.getElementById('element-length'),
    width: document.getElementById('element-width'),
    climate: document.getElementById('climate-select'),
    usage: document.getElementById('usage-select'),
    poolDepth: document.getElementById('pool-depth')
};

// =============================================================================
// 3. CLASSE CANVAS ELEMENT
// =============================================================================

class CanvasElement {
    constructor(type, length, width, x, y) {
        this.id = Date.now() + Math.random();
        this.type = type;
        this.length = parseFloat(length);
        this.width = parseFloat(width);
        this.x = x;
        this.y = y;
        this.rotation = 0;
        this.config = { ...toolSettings };
        
        if(type === 'pool') {
            this.config.poolDepth = parseFloat(inputs.poolDepth.value) || 1.40;
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
        return 'NORTE';
    }

    drawSolarArrays(bestOption, safeFall, safeLength) {
        const oldLayer = this.el.querySelector('.solar-layer');
        if (oldLayer) oldLayer.remove();

        const layer = document.createElement('div');
        layer.className = 'solar-layer';

        const m = MARGIN_SAFETY * PIXELS_PER_METER;
        const gap = BATTERY_GAP * PIXELS_PER_METER;
        const colH = bestOption.col.len * PIXELS_PER_METER;
        const colW = bestOption.col.width * PIXELS_PER_METER;

        const orientation = this.getOrientation();
        const faces = this.config.roofFaces;
        
        let zones = [];
        const fullW_px = this.length * PIXELS_PER_METER;
        const fullH_px = this.width * PIXELS_PER_METER;
        let halfH = fullH_px / 2;
        let zoneW, zoneH;

        if (orientation === 'LESTE' || orientation === 'OESTE') {
            zoneW = fullH_px - (2 * m);
            zoneH = fullW_px; 
        } else {
            zoneW = fullW_px - (2 * m);
            zoneH = fullH_px; 
        }

        if (faces === 1) {
            zones.push({ top: m, left: m, h: zoneH - (2*m), w: zoneW });
        } else {
            if (orientation === 'LESTE' || orientation === 'OESTE') {
                const topSide = (orientation === 'LESTE') ? 'LESTE' : 'OESTE';
                const bottomSide = (orientation === 'LESTE') ? 'OESTE' : 'LESTE';
                zones.push({ top: m, left: m, h: halfH - (2*m), w: zoneW, side: topSide });
                zones.push({ top: halfH + m, left: m, h: halfH - (2*m), w: zoneW, side: bottomSide });
            } else {
                const topY = (orientation === 'NORTE') ? m : (halfH + m);
                zones.push({ top: topY, left: m, h: halfH - (2*m), w: zoneW });
            }
        }
        
        let platesTotal = bestOption.realQty;
        let platesDistributed = 0;
        const distribution = this.solarData.distribution;
        let targetLeste = distribution ? Math.ceil(platesTotal * distribution.LESTE) : 0;
        let targetOeste = distribution ? (platesTotal - targetLeste) : 0;

        zones.forEach((zone, zIndex) => {
            let zoneTargetQty;
            if (distribution && zone.side) {
                zoneTargetQty = (zone.side === 'LESTE') ? targetLeste : targetOeste;
            } else {
                if (zIndex === 0) zoneTargetQty = Math.ceil(platesTotal / bestOption.totalUsefulFaces);
                else zoneTargetQty = platesTotal - platesDistributed;
            }
            
            if (zoneTargetQty <= 0) return;
            if (!distribution && zIndex === zones.length - 1) zoneTargetQty = platesTotal - platesDistributed;

            platesDistributed += zoneTargetQty;

            const rowsAvailable = bestOption.rowsPerFace || 1;
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

                    const batWidth = size * colW;
                    
                    // Desenho simples (sem colisão)
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
        this.el.style.left = `${this.x}px`;
        this.el.style.top = `${this.y}px`;
        this.el.style.transform = `rotate(${this.rotation}deg)`;
    
        this.el.className = `element ${this.type}`;
        if (this.type === 'pool') this.el.classList.add(this.config.poolShape);
        if (this.id == selectedElementId) this.el.classList.add('selected');
    
        let innerHTML = '';
        
        if (this.type === 'roof') {
            const orientation = this.getOrientation();
            const faces = this.config.roofFaces;
            const isSouth = orientation === 'SUL' && faces === 1; 
            const arrowColor = isSouth ? '#ff0000' : 'white';
            
            innerHTML += `<div class="direction-arrow" style="border-bottom-color: ${arrowColor}"></div>
                          <div class="orientation-label" style="color:${arrowColor}">${orientation}</div>`;
            
            if (faces === 2) {
                innerHTML += `<div class="roof-divider horizontal"></div>`;
                const halfWidth = (this.width / 2).toFixed(2);
                innerHTML += `<div class="ruler-text top-half">${halfWidth}m</div>
                              <div class="ruler-text bottom-half">${halfWidth}m</div>`;
    
                if (this.rotation % 360 === 0) innerHTML += `<div class="bad-zone bottom-half"></div>`;
                else if (this.rotation % 360 === 180) innerHTML += `<div class="bad-zone top-half"></div>`;
            }
            
            if (faces === 4) {
                innerHTML += `<div class="roof-divider vertical"></div><div class="roof-divider horizontal"></div>`;
                const rot = this.rotation % 360;
                if (rot === 0) innerHTML += `<div class="bad-zone triangle-bottom"></div>`;
                if (rot === 180) innerHTML += `<div class="bad-zone triangle-top"></div>`;
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
    
        if (this.solarData) {
            setTimeout(() => this.drawSolarArrays(this.solarData.bestOption, this.solarData.h, this.solarData.w), 0);
        }
    }

    attachEvents() {
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
// 4. ALGORITMO DE CÁLCULO
// =============================================================================

function calculateSolarSystem() {
    const resultsContainer = document.getElementById('solar-results');
    const tableBody = document.getElementById('collectors-tbody');
    
    const pool = elements.find(e => e.type === 'pool');
    const roof = elements.find(e => e.type === 'roof');

    if (!pool) return alert("Adicione uma piscina.");
    if (!roof) return alert("Adicione um telhado ao projeto.");
    
    elements.forEach(e => { 
        if(e.type === 'roof') {
            e.solarData = null;
            const l = e.el.querySelector('.solar-layer');
            if(l) l.remove();
        }
    });

    const orientation = roof.getOrientation();
    const faces = roof.config.roofFaces;
    if (faces === 1 && orientation === 'SUL') return alert("Instalação proibida na face SUL.");

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
    let effectiveOrientation; 
    
    if (faces === 2 && (orientation === 'LESTE' || orientation === 'OESTE')) {
        factorFace = ORIENTATION_FACTORS['LESTE'];
        effectiveOrientation = 'LESTE/OESTE';
    } else {
        factorFace = ORIENTATION_FACTORS[orientation];
        effectiveOrientation = orientation;
    }

    const requiredPlateArea = poolBaseArea * factorClimate * factorFace;

    // GEOMETRIA DO TELHADO
    const realLength = roof.length;
    const realWidth = roof.width;
    
    let safeFall = 0; 
    let safeLength = 0;
    let totalUsefulFaces = 1;
    
    safeLength = Math.max(0, realLength - (MARGIN_SAFETY * 2));
    
    if (faces === 1) {
        safeFall = Math.max(0, realWidth - (MARGIN_SAFETY * 2));
        totalUsefulFaces = 1;
    } else if (faces === 2) {
        const halfWidth = realWidth / 2;
        safeFall = Math.max(0, halfWidth - (MARGIN_SAFETY * 2));
        if (orientation === 'NORTE' || orientation === 'SUL') totalUsefulFaces = 1;
        else totalUsefulFaces = 2;
    } else {
        safeFall = Math.max(0, (realWidth / 2) - (MARGIN_SAFETY * 2));
        totalUsefulFaces = 1;
    }

    // INVENTÁRIO (LOOP DE COLETORES)
    let bestOption = null;
    let htmlRows = '';

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
                maxPlatesInRow = Math.ceil(platesLeste / rowsPerFace);
            } else {
                maxPlatesInRow = Math.ceil(realQtyNeeded / totalRowsAvailable);
            }
            
            const batsInRow = Math.ceil(maxPlatesInRow / MAX_PLATES_PER_BATTERY);
            const widthNeeded = (maxPlatesInRow * col.width) + ((batsInRow - 1) * BATTERY_GAP);
            
            if (widthNeeded <= safeLength) {
                fits = true;
                invadesMargin = false;
            } else if (widthNeeded <= realLength) {
                fits = true;
                invadesMargin = true;
            } else {
                fits = false;
            }

            if (fits) {
                // Cálculo de Baterias Físicas
                let totalBats = 0;
                if (totalUsefulFaces === 2 && (effectiveOrientation === 'LESTE/OESTE' || totalUsefulFaces === 2)) {
                    const qtyLeste = Math.ceil(realQtyNeeded * DISTRIBUTION_L_O.LESTE);
                    const qtyOeste = realQtyNeeded - qtyLeste;
                    const calcFaceBatteries = (qty, rows) => {
                        let bats = 0;
                        let left = qty;
                        for(let r=0; r<rows; r++) {
                            let inRow = Math.ceil(left / (rows - r));
                            left -= inRow;
                            bats += Math.ceil(inRow / MAX_PLATES_PER_BATTERY);
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
                    }
                }
                finalBatteries = totalBats;

                if (invadesMargin) fittingDetails = "<strong style='color:#f57f17'>⚠ Invade Margem</strong>";
                else fittingDetails = `${finalBatteries} Baterias (Ideal)`;
            } else {
                if (!fittingDetails) fittingDetails = "Telhado estreito (falta largura)";
            }
        }

        const purchaseQty = Math.ceil(realQtyNeeded / 10) * 10;
        let isRecommended = false;
        if (fits) {
            if (!bestOption) {
                bestOption = { col, realQty: realQtyNeeded, purchaseQty, batteries: finalBatteries, rowsPerFace, totalUsefulFaces, invadesMargin };
                isRecommended = true;
            } else if (realQtyNeeded < bestOption.realQty) {
                bestOption = { col, realQty: realQtyNeeded, purchaseQty, batteries: finalBatteries, rowsPerFace, totalUsefulFaces, invadesMargin };
                isRecommended = true;
            }
        }

        const rowClass = (bestOption && bestOption.col.name === col.name) ? 'row-recommended' : '';
        const statusClass = fits ? 'status-ok' : 'status-error';

        htmlRows += `
            <tr class="${rowClass}">
                <td><strong>${col.name}</strong>${(bestOption && bestOption.col.name === col.name) ? '<span class="badge-best">MELHOR</span>' : ''}</td>
                <td><strong>${realQtyNeeded}</strong></td>
                <td>${fits ? finalBatteries : '-'}</td>
                <td class="${statusClass}">
                    ${fits ? 'CABE' : 'NÃO'} <br>
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

    if (bestOption) {
        const baseFlow = bestOption.realQty * 0.6 * 200;
        const totalFlowLPH = baseFlow * 1.15;
        const connectionType = document.getElementById('connection-type').value;
        let vqvCount = (connectionType === 'series') ? Math.ceil(bestOption.batteries / 3) : bestOption.batteries;
        const kitsCount = bestOption.batteries;

        // Aviso de Margem
        const totalSlots = bestOption.rowsPerFace * bestOption.totalUsefulFaces;
        let maxPlatesInRowToDisplay;
        if (bestOption.totalUsefulFaces === 2) {
            const platesLeste = Math.ceil(bestOption.realQty * DISTRIBUTION_L_O.LESTE);
            maxPlatesInRowToDisplay = Math.ceil(platesLeste / bestOption.rowsPerFace);
        } else {
            maxPlatesInRowToDisplay = Math.ceil(bestOption.realQty / totalSlots);
        }
        
        const batsInRow = Math.ceil(maxPlatesInRowToDisplay / MAX_PLATES_PER_BATTERY);
        const widthOccupied = (maxPlatesInRowToDisplay * bestOption.col.width) + ((batsInRow - 1) * BATTERY_GAP);
        
        let warningHtml = '';
        if (widthOccupied > safeLength) {
             warningHtml = `<div class="margin-warning" style="background-color:#fff8e1; color:#f57f17; border-color:#ffe0b2">
                <i class="fas fa-exclamation-circle"></i> 
                <strong>ATENÇÃO:</strong> Cabe no telhado, porém deve ser seguida as orientações do manual.
             </div>`;
        }

        document.getElementById('best-option-title').innerHTML = `<i class="fas fa-star"></i> Recomendado: ${bestOption.col.name} ${warningHtml}`;
        document.getElementById('res-batteries').textContent = bestOption.batteries;
        document.getElementById('res-kits').textContent = kitsCount;
        document.getElementById('res-vqv').textContent = vqvCount;
        const flowEl = document.getElementById('res-flow');
        if(flowEl) flowEl.textContent = totalFlowLPH.toFixed(0) + " L/h";

        roof.solarData = { 
            bestOption, 
            h: safeFall, 
            w: safeLength, 
            orientation: orientation,
            distribution: totalUsefulFaces === 2 ? DISTRIBUTION_L_O : null
        };
        roof.drawSolarArrays(bestOption, safeFall, safeLength);

        const msg = `Olá, solicito orçamento:
*Projeto TS Solar*
---------------------------
- Piscina: ${poolBaseArea.toFixed(1)}m²
- Telhado Útil: ${safeLength.toFixed(1)}m x ${safeFall.toFixed(1)}m
- Demanda Térmica: ${requiredPlateArea.toFixed(1)}m²

*Materiais Recomendados:*
- ${bestOption.purchaseQty} ${bestOption.col.name} (Qtd Real: ${bestOption.realQty})
- ${bestOption.batteries} Kits de Fechamento
- ${vqvCount} Válvulas Quebra-Vácuo (VQV)
${widthOccupied > safeLength ? '*Obs: Instalação invade margem de segurança.*' : ''}`;

        const btnWa = document.getElementById('btn-whatsapp');
        if(btnWa) {
            // NÃO definimos o href aqui. Apenas guardamos a mensagem.
            btnWa.dataset.msg = msg; 
            btnWa.href = "#"; // Placeholder
            btnWa.style.display = 'flex';
        }
    } else {
        document.getElementById('best-option-title').textContent = "Nenhum coletor cabe neste telhado";
        ['res-batteries', 'res-kits', 'res-vqv'].forEach(id => document.getElementById(id).textContent = '-');
        const flowEl = document.getElementById('res-flow');
        if(flowEl) flowEl.textContent = '-';
        const btnWa = document.getElementById('btn-whatsapp');
        if(btnWa) btnWa.style.display = 'none';
    }
    
    resultsContainer.style.display = 'block';
    if(isMobile) setTimeout(() => resultsContainer.scrollIntoView({ behavior: 'smooth' }), 100);
}


// =============================================================================
// 5. EVENTOS E UTILITÁRIOS
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    
    function updateInputVisibility(mode) {
        const dimsContainer = document.querySelector('.measurement-inputs');
        const volContainer = document.getElementById('vol-input-group');

        if (mode === 'vol') {
            dimsContainer.classList.add('hidden-inputs'); 
            volContainer.style.display = 'block';         
        } else {
            dimsContainer.classList.remove('hidden-inputs'); 
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

    // ADICIONAR ELEMENTO
    document.getElementById('add-element').addEventListener('click', () => {
        if (currentToolType === 'roof') {
            const existingRoof = elements.find(e => e.type === 'roof');
            if (existingRoof) return alert("O projeto permite apenas 1 telhado.");
        }
        
        let len, wid;
        if (currentToolType === 'pool' && poolInputMode === 'vol') {
            const volumeL = parseFloat(document.getElementById('pool-volume').value);
            const depth = parseFloat(document.getElementById('pool-depth').value);
            if (!volumeL || !depth) return alert("Informe volume e profundidade.");
            const areaSurf = volumeL / 1000 / depth;

            if (toolSettings.poolShape === 'circular') {
                const radius = Math.sqrt(areaSurf / Math.PI);
                len = radius * 2; wid = radius * 2;
            } else {
                const side = Math.sqrt(areaSurf);
                len = side; wid = side;
            }
        } else {
            len = parseFloat(inputs.length.value);
            wid = parseFloat(inputs.width.value);
        }
        
        const posX = isMobile ? 20 : 100;
        const posY = isMobile ? 20 : 100;
        const newEl = new CanvasElement(currentToolType, len, wid, posX, posY);
        elements.push(newEl);
        canvas.appendChild(newEl.el);
        selectElement(newEl.id);
        updateCounters();
    });

    // BOTÕES DE MODO
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => setPoolInputMode(btn.dataset.mode));
    });

    // BOTÕES DE TIPO
    document.querySelectorAll('.type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentToolType = btn.dataset.type;
            
            const roofSpec = document.getElementById('roof-specifics');
            const poolSpec = document.getElementById('pool-specifics');
            if(roofSpec) roofSpec.style.display = currentToolType === 'roof' ? 'block' : 'none';
            if(poolSpec) poolSpec.style.display = currentToolType === 'pool' ? 'block' : 'none';

            if (currentToolType === 'pool') {
                updateInputVisibility(poolInputMode);
            } else {
                const dimsContainer = document.querySelector('.measurement-inputs');
                const volContainer = document.getElementById('vol-input-group');
                dimsContainer.classList.remove('hidden-inputs');
                volContainer.style.display = 'none';
            }
        });
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
                setPoolInputMode('vol');
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

    // ROTAÇÃO
    const btnLeft = document.getElementById('rotate-left');
    const btnRight = document.getElementById('rotate-right');
    if(btnLeft) btnLeft.addEventListener('click', () => rotateSelected('left'));
    if(btnRight) btnRight.addEventListener('click', () => rotateSelected('right'));
    
    // AÇÕES
    document.getElementById('btn-calculate-solar').addEventListener('click', calculateSolarSystem);
    document.getElementById('delete-selected').addEventListener('click', deleteSelected);
    document.getElementById('delete-all').addEventListener('click', () => {
        if(confirm('Limpar tudo?')) {
            canvas.innerHTML = ''; elements = []; selectedElementId = null;
            document.getElementById('selection-panel').style.display = 'none';
            document.getElementById('solar-results').style.display = 'none';
            updateCounters();
        }
    });

    // SELEÇÃO
    canvas.addEventListener('mousedown', (e) => { if (e.target === canvas) deselectAll(); });
    canvas.addEventListener('touchstart', (e) => { if (e.target === canvas) deselectAll(); });
	setupWhatsAppRouting();
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
        document.getElementById('sel-type').textContent = el.type.toUpperCase();
        document.getElementById('sel-area').textContent = el.getArea().toFixed(2);
        if (el.type === 'roof') updateOrientationDisplay(el.getOrientation());
    }
}

function rotateSelected(dir) {
    const el = elements.find(e => e.id === selectedElementId);
    if (!el || el.type !== 'roof') return;
    el.rotation += (dir === 'left' ? -90 : 90);
    if (el.rotation < 0) el.rotation += 360;
    
    el.render();
    if (el.solarData) {
        el.solarData.orientation = el.getOrientation();
        el.drawSolarArrays(el.solarData.bestOption, el.solarData.h, el.solarData.w);
    }
    updateOrientationDisplay(el.getOrientation());
}

function updateOrientationDisplay(txt) {
    const d = document.getElementById('current-orientation-display');
    if(d) {
        d.textContent = txt;
        d.style.color = txt === 'SUL' ? 'red' : '#333';
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
    }
}

function startDrag(e, canvasEl) {
    const startX = e.clientX || (e.touches && e.touches[0].clientX);
    const startY = e.clientY || (e.touches && e.touches[0].clientY);
    
    const elemX = canvasEl.x;
    const elemY = canvasEl.y;

    // Dimensões do Canvas (A "Parede")
    const container = document.getElementById('canvas');
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    // Dimensões do Elemento (em Pixels)
    const elW = canvasEl.length * PIXELS_PER_METER;
    const elH = canvasEl.width * PIXELS_PER_METER;

    function onMove(ev) {
        let cx = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX;
        let cy = ev.type === 'touchmove' ? ev.touches[0].clientY : ev.clientY;
        
        if(ev.type === 'touchmove') ev.preventDefault(); 
        
        // Calcula a nova posição proposta
        let newX = elemX + (cx - startX);
        let newY = elemY + (cy - startY);

        // --- TRAVAS DE SEGURANÇA (PAREDES) ---
        
        // 1. Não deixa sair pela Esquerda (X < 0)
        if (newX < 0) newX = 0;
        
        // 2. Não deixa sair pelo Topo (Y < 0)
        if (newY < 0) newY = 0;
        
        // 3. Não deixa sair pela Direita (X + Largura > LarguraCanvas)
        if (newX + elW > containerW) newX = containerW - elW;
        
        // 4. Não deixa sair por Baixo (Y + Altura > AlturaCanvas)
        if (newY + elH > containerH) newY = containerH - elH;

        // Aplica a posição segura
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