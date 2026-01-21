/**
 * Werewolf / Among Us Interactive Terminal
 * 
 * A rich terminal UI for the Privacy-Preserving Werewolf Game.
 * Features:
 * - Real-time Player Status Table
 * - Detailed Contract Call Logging
 * - Trusted Node State Management
 */

import { Buffer } from 'node:buffer';
import * as readline from 'node:readline';
import { createHash } from 'node:crypto';
import {
    createConstructorContext,
    CostModel,
    QueryContext,
    sampleContractAddress,
    type CircuitContext
} from '@midnight-ntwrk/compact-runtime';

import { Contract, type Witnesses } from '../ww-dist/contract/index.js';

// ============================================
// ANSI COLORS & STYLING
// ============================================
const C = {
    RESET: "\x1b[0m",
    BRIGHT: "\x1b[1m",
    DIM: "\x1b[2m",
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    BLUE: "\x1b[34m",
    CYAN: "\x1b[36m",
    WHITE: "\x1b[37m",
    BG_RED: "\x1b[41m"
};

// ============================================
// CONSTANTS
// ============================================

const Role = {
    Villager: 0,
    Werewolf: 1,
    Seer: 2,
    Doctor: 3
}

const Phase = {
    Lobby: 0,
    Night: 1,
    Day: 2,
    Finished: 3
}

const ROLE_STR = {
    [Role.Villager]: "Villager 👱",
    [Role.Werewolf]: "Werewolf 🐺",
    [Role.Seer]:     "Seer     🔮",
    [Role.Doctor]:   "Doctor   💉"
};

const PHASE_STR = {
    [Phase.Lobby]:    "LOBBY",
    [Phase.Night]:    "NIGHT 🌙",
    [Phase.Day]:      "DAY   ☀️",
    [Phase.Finished]: "GAME OVER"
};

// ============================================
// CRYPTO HELPERS
// ============================================

function sha256(data: Uint8Array): Uint8Array {
    return createHash('sha256').update(data).digest();
}

function randomBytes(len: number): Uint8Array {
    const b = new Uint8Array(len);
    for(let i=0; i<len; i++) b[i] = Math.floor(Math.random()*256);
    return b;
}

function toHex(b: Uint8Array): string {
    return Buffer.from(b).toString('hex').slice(0,6);
}

// Mock Merkle Tree for UI simulation
class MerkleTree {
    leaves: Uint8Array[];
    constructor(leaves: Uint8Array[]) { this.leaves = leaves; }
    getRootDigest() { return { field: 12345n }; } // Mock
    getProof(index: number) {
        const path: any[] = [];
        for(let i=0; i<10; i++) path.push({ sibling: { field: 0n }, goes_left: index%2!==0 });
        return { leaf: this.leaves[index], path };
    }
}

// ============================================
// TRUSTED NODE (The "Server")
// ============================================

interface PlayerPrivateState {
    id: number;
    role: number;
    alive: boolean;
    secretKey: Uint8Array; // Identity Secret
    salt: Uint8Array;      // Role Commitment Salt
    publicKey: Uint8Array;
    hasActed: boolean;     // Track if they submitted a tx this turn
    voteTarget: number;    // Pending vote/action target
}

class TrustedNode {
    contract: Contract<any, any>;
    context: CircuitContext<any>;
    gameId: Uint8Array;
    adminKey: Uint8Array;
    
    // SECRET DATA (Held only by Trusted Node)
    private players: PlayerPrivateState[] = [];
    private logs: string[] = [];

    constructor() {
        this.contract = new Contract({});
        const initial = this.contract.initialState(createConstructorContext({}, '0'.repeat(64)));
        this.context = {
            currentPrivateState: initial.currentPrivateState,
            currentZswapLocalState: initial.currentZswapLocalState,
            currentQueryContext: new QueryContext(initial.currentContractState.data, sampleContractAddress()),
            costModel: CostModel.initialCostModel()
        };
        this.gameId = randomBytes(32);
        this.adminKey = new Uint8Array(32);
    }

    // --- LOGGING HELPER ---
    private logCall(caller: string, func: string, ...args: any[]) {
        const argStr = args.map(a => 
            typeof a === 'bigint' ? `${a}n` : 
            (a instanceof Uint8Array || (a && a.bytes)) ? `Bytes<32>` : 
            JSON.stringify(a)
        ).join(', ');
        
        const timestamp = new Date().toLocaleTimeString();
        this.logs.push(`${C.DIM}[${timestamp}]${C.RESET} ${C.CYAN}[${caller}]${C.RESET} called ${C.YELLOW}${func}${C.RESET}(${argStr})`);
        
        // Keep log size manageable
        if (this.logs.length > 8) this.logs.shift();
    }

    // --- PUBLIC GETTERS FOR UI ---
    getLogHistory() { return this.logs; }
    
    getPlayersPublicInfo() {
        return this.players.map(p => ({
            id: p.id,
            role: p.role, // In real UI, this might be hidden for others, but we show for God View
            alive: p.alive,
            hasActed: p.hasActed
        }));
    }

    // --- GAME ACTIONS ---

    async initAdmin() {
        // Simulate fetching key
        try {
            const r = this.contract.circuits.getAdminKey(this.context);
            this.context = r.context;
            this.adminKey = r.result.bytes;
            this.logCall("ADMIN", "getAdminKey");
        } catch { /* ignore in mock */ }
    }

    async createGame(count: number, wolves: number) {
        this.players = [];
        for (let i = 0; i < count; i++) {
            this.players.push({
                id: i,
                role: i < wolves ? Role.Werewolf : Role.Villager,
                alive: true,
                secretKey: randomBytes(32),
                salt: randomBytes(32),
                publicKey: randomBytes(32),
                hasActed: false,
                voteTarget: -1
            });
        }

        const leaves = this.players.map(p => sha256(p.secretKey));
        const tree = new MerkleTree(leaves);
        
        // Mock Configs
        const configs = Array(10).fill(null).map((_, i) => ({
            publicKey: { bytes: i < count ? this.players[i].publicKey : new Uint8Array(32) },
            roleCommitment: new Uint8Array(32),
            encryptedRole: { x: 0n, y: 0n }
        }));

        this.logCall("ADMIN", "createGame", `ID:${toHex(this.gameId)}`, `Players:${count}`);
        
        const r = this.contract.circuits.createGame(
            this.context,
            this.gameId,
            { bytes: this.adminKey },
            tree.getRootDigest(),
            configs,
            BigInt(count),
            BigInt(wolves)
        );
        this.context = r.context;
    }

    async submitAction(playerId: number, targetId: number) {
        const p = this.players[playerId];
        if (!p.alive) return;

        p.voteTarget = targetId;
        p.hasActed = true;

        const phase = this.getPhase();
        
        // Generate Mock Merkle Proof
        const tree = new MerkleTree(this.players.map(pl => sha256(pl.secretKey)));
        const proof = tree.getProof(playerId);

        if (phase === Phase.Night) {
            this.logCall(`Player ${playerId}`, "nightAction", `Target:${targetId}`, "Proof...");
            try {
                const r = this.contract.circuits.nightAction(
                    this.context,
                    this.gameId,
                    randomBytes(32), // Encrypted Action
                    proof as any,
                    p.secretKey
                );
                this.context = r.context;
            } catch (e) { /* Expected failure in mock due to proof hash mismatch */ }
        } else {
            this.logCall(`Player ${playerId}`, "voteDay", `Target:${targetId}`, "Proof...");
            try {
                const r = this.contract.circuits.voteDay(
                    this.context,
                    this.gameId,
                    randomBytes(32),
                    proof as any,
                    p.secretKey
                );
                this.context = r.context;
            } catch (e) { /* Expected failure in mock */ }
        }
    }

    async resolveTurn() {
        const phase = this.getPhase();
        const round = this.getRound();

        if (phase === Phase.Night) {
            // Logic: Werewolves kill
            const wolfAction = this.players.find(p => p.role === Role.Werewolf && p.alive && p.voteTarget !== -1);
            let victim = -1;
            let hasDeath = false;

            if (wolfAction) {
                victim = wolfAction.voteTarget;
                hasDeath = true;
                this.players[victim].alive = false;
                this.logs.push(`${C.BG_RED}${C.WHITE} 💀 KILL: Werewolf killed Player ${victim} ${C.RESET}`);
            } else {
                this.logs.push(`${C.GREEN} 🌙 Night passed peacefully. ${C.RESET}`);
            }

            this.logCall("ADMIN", "resolveNightPhase", round + 1n, victim, hasDeath);
            
            try {
                const r = this.contract.circuits.resolveNightPhase(
                    this.context,
                    this.gameId,
                    round + 1n,
                    BigInt(victim >= 0 ? victim : 0),
                    hasDeath,
                    { field: 0n } // New root
                );
                this.context = r.context;
            } catch (e) { /* ignore mock error */ }

        } else if (phase === Phase.Day) {
            // Logic: Majority Vote
            const votes: Record<number, number> = {};
            this.players.forEach(p => {
                if (p.alive && p.voteTarget !== -1) {
                    votes[p.voteTarget] = (votes[p.voteTarget] || 0) + 1;
                }
            });

            let eliminated = -1;
            let maxV = 0;
            for(const [t, c] of Object.entries(votes)) {
                if (c > maxV) { maxV = c; eliminated = Number(t); }
                else if (c === maxV) { eliminated = -1; }
            }

            let hasElim = false;
            if (eliminated !== -1) {
                hasElim = true;
                this.players[eliminated].alive = false;
                this.logs.push(`${C.BG_RED}${C.WHITE} 🔥 LYNCH: The town voted out Player ${eliminated} ${C.RESET}`);
                // Reveal logic
                await this.revealRole(eliminated);
            } else {
                this.logs.push(`${C.YELLOW} 🕊️  Vote tied. No one died. ${C.RESET}`);
            }

            this.logCall("ADMIN", "resolveDayPhase", eliminated, hasElim);
            
            try {
                const r = this.contract.circuits.resolveDayPhase(
                    this.context,
                    this.gameId,
                    BigInt(eliminated >= 0 ? eliminated : 0),
                    hasElim
                );
                this.context = r.context;
            } catch (e) { /* ignore mock error */ }
        }

        // Reset turn flags
        this.players.forEach(p => { p.hasActed = false; p.voteTarget = -1; });
    }

    async revealRole(playerId: number) {
        const p = this.players[playerId];
        this.logCall("ADMIN", "revealPlayerRole", playerId, p.role);
        try {
            const r = this.contract.circuits.revealPlayerRole(
                this.context,
                this.gameId,
                BigInt(playerId),
                BigInt(p.role),
                p.salt
            );
            this.context = r.context;
        } catch { }
    }

    // --- CONTRACT STATE ---
    getState() {
        try {
            const r = this.contract.circuits.getGameState(this.context, this.gameId);
            this.context = r.context;
            return r.result;
        } catch { return null; }
    }

    getPhase(): number { const s = this.getState(); return s ? Number(s.phase) : Phase.Lobby; }
    getRound(): bigint { const s = this.getState(); return s ? s.round : 0n; }
}

// ============================================
// INTERACTIVE TERMINAL UI
// ============================================

const node = new TrustedNode();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function clearScreen() {
    console.clear();
}

function printHeader() {
    const phase = node.getPhase();
    const round = node.getRound();
    
    console.log(`${C.BRIGHT}${C.BLUE}============================================================${C.RESET}`);
    console.log(`   🐺  ${C.BRIGHT}PRIVACY-PRESERVING WEREWOLF${C.RESET}  |  Powered by Midnight`);
    console.log(`${C.BRIGHT}${C.BLUE}============================================================${C.RESET}`);
    console.log(`\n   Phase: ${C.BRIGHT}${PHASE_STR[phase]}${C.RESET}  |  Round: ${C.BRIGHT}${round}${C.RESET}`);
    console.log(`   Contract ID: ${C.DIM}${toHex(node.gameId)}${C.RESET}`);
    console.log("");
}

function printPlayers() {
    const players = node.getPlayersPublicInfo();
    if (players.length === 0) {
        console.log(`   ${C.DIM}(No players in lobby)${C.RESET}\n`);
        return;
    }

    console.log(`   ${C.BRIGHT}PLAYERS:${C.RESET}`);
    console.log(`   --------------------------------------------------------`);
    console.log(`   | ID | ${"Role".padEnd(12)} | Status   | Action Submitted? |`);
    console.log(`   --------------------------------------------------------`);

    players.forEach(p => {
        const roleText = ROLE_STR[p.role].padEnd(12);
        
        let status = `${C.GREEN}Alive${C.RESET}   `;
        if (!p.alive) status = `${C.RED}DEAD 💀${C.RESET}  `;

        let acted = p.hasActed ? `${C.GREEN}Yes ✅${C.RESET}` : `${C.DIM}No  ...${C.RESET}`;
        if (!p.alive) acted = `${C.DIM}---${C.RESET}`;

        // Gray out dead rows
        const prefix = p.alive ? "   " : `   ${C.DIM}`;
        const suffix = p.alive ? "" : `${C.RESET}`;

        console.log(`${prefix}| ${p.id.toString().padEnd(2)} | ${roleText} | ${status}  | ${acted.padEnd(26)} |${suffix}`);
    });
    console.log(`   --------------------------------------------------------\n`);
}

function printLogs() {
    console.log(`   ${C.BRIGHT}TRUSTED NODE LOGS:${C.RESET}`);
    const logs = node.getLogHistory();
    if (logs.length === 0) console.log(`   ${C.DIM}(No activity yet)${C.RESET}`);
    logs.forEach(l => console.log(`   ${l}`));
    console.log("");
}

function printMenu() {
    const phase = node.getPhase();
    console.log(`${C.BLUE}--- ACTIONS ---${C.RESET}`);
    
    if (phase === Phase.Lobby) {
        console.log(`   1. Start New Game (5 Players, 1 Wolf)`);
    } else if (phase === Phase.Finished) {
        console.log(`   1. Reset Game`);
    } else {
        // Active Game
        const actionVerb = phase === Phase.Night ? "Action" : "Vote";
        console.log(`   1. Submit ${actionVerb} (as Player ID)`);
        console.log(`   2. ${C.YELLOW}[ADMIN] Resolve Phase${C.RESET}`);
    }
    console.log(`   9. Exit`);
    rl.question(`\n${C.BRIGHT}> Select Option: ${C.RESET}`, handleInput);
}

function render() {
    clearScreen();
    printHeader();
    printPlayers();
    printLogs();
    printMenu();
}

async function handleInput(input: string) {
    const phase = node.getPhase();
    const choice = input.trim();

    try {
        switch(choice) {
            case '1': // Context dependent action
                if (phase === Phase.Lobby || phase === Phase.Finished) {
                    await node.initAdmin();
                    await node.createGame(5, 1);
                } else {
                    await promptAction();
                    return; // Prompt calls render
                }
                break;
            case '2': // Resolve
                if (phase === Phase.Night || phase === Phase.Day) {
                    await node.resolveTurn();
                }
                break;
            case '9':
                console.log("Exiting...");
                process.exit(0);
                break;
        }
    } catch (e: any) {
        // Catch simulation errors
    }
    render();
}

async function promptAction() {
    const phase = node.getPhase();
    const actionName = phase === Phase.Night ? "Target" : "Vote";
    
    rl.question(`   Enter Your Player ID: `, (uid) => {
        rl.question(`   Enter ${actionName} ID: `, async (tid) => {
            const u = parseInt(uid);
            const t = parseInt(tid);
            
            if (!isNaN(u) && !isNaN(t)) {
                await node.submitAction(u, t);
            }
            render();
        });
    });
}

// Start
render();