import * as recastNavigationThree from "@recast-navigation/three";
import GUI from "lil-gui";
import * as navcat from "navcat";
import * as navcatBlocks from "navcat/blocks";
import * as navcatThree from "navcat/three";
import * as recastNavigation from "recast-navigation";
import * as recastNavigationGenerators from "recast-navigation/generators";
import * as THREE from "three";
import { GLTFLoader, OrbitControls } from "three/addons";

type BenchmarkResult = {
	name: string;
	warmupRuns: number;
	runs: number;
	times: number[];
	mean: number;
	median: number;
	min: number;
	max: number;
	stdDev: number;
};

type SceneSetup = {
	renderer: THREE.WebGLRenderer;
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	controls: OrbitControls;
	positions: Float32Array;
	indices: Uint32Array;
};

type GenerationResults = {
	navcatNav: navcat.NavMesh;
	navcatIntermediates: navcatBlocks.SoloNavMeshIntermediates;
	navcatGenTime: BenchmarkResult;
	recastNav: recastNavigation.NavMesh;
	recastGenTime: BenchmarkResult;
};

type PathVerification = {
	navcatPath: navcat.FindPathResult | null;
	recastPath: recastNavigation.Vector3[] | null;
	navcatPathVisuals: THREE.Group;
	recastPathVisuals: THREE.Group;
};

type GenerationOptions = {
	cellSize: number;
	cellHeight: number;
	walkableRadiusVoxels: number;
	walkableRadiusWorld: number;
	walkableClimbVoxels: number;
	walkableClimbWorld: number;
	walkableHeightVoxels: number;
	walkableHeightWorld: number;
	walkableSlopeAngleDegrees: number;
	borderSize: number;
	minRegionArea: number;
	mergeRegionArea: number;
	maxSimplificationError: number;
	maxEdgeLength: number;
	maxVerticesPerPoly: number;
	detailSampleDistance: number;
	detailSampleMaxError: number;
};

type NavMeshVisuals = {
	navcatHelper: ReturnType<typeof navcatThree.createNavMeshHelper>;
	recastDebugDrawer: recastNavigationThree.DebugDrawer;
};

type QueryBenchmarkResults = {
	navcatQueryTime: BenchmarkResult;
	recastQueryTime: BenchmarkResult;
};

// ============================================================================
// Utility Functions
// ============================================================================

function benchmark(
	name: string,
	fn: () => void,
	warmupRuns = 3,
	runs = 10,
): BenchmarkResult {
	// warmup
	console.log(`${name}: running ${warmupRuns} warmup iterations...`);
	for (let i = 0; i < warmupRuns; i++) {
		fn();
	}

	// actual runs
	console.log(`${name}: running ${runs} benchmark iterations...`);
	const times: number[] = [];
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		fn();
		const end = performance.now();
		times.push(end - start);
	}

	// calculate stats
	const sorted = [...times].sort((a, b) => a - b);
	const mean = times.reduce((a, b) => a + b, 0) / times.length;
	const median = sorted[Math.floor(sorted.length / 2)];
	const min = sorted[0];
	const max = sorted[sorted.length - 1];

	const variance =
		times.reduce((sum, time) => sum + (time - mean) ** 2, 0) / times.length;
	const stdDev = Math.sqrt(variance);

	return {
		name,
		warmupRuns,
		runs,
		times,
		mean,
		median,
		min,
		max,
		stdDev,
	};
}

async function loadGLB(url: string) {
	const loader = new GLTFLoader();
	return await new Promise<THREE.Group>((resolve, reject) => {
		loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
	});
}

function gatherTrianglesFromScene(object: THREE.Object3D) {
	const positions: number[] = [];
	const indices: number[] = [];
	let vertexOffset = 0;

	object.traverse((child) => {
		if ((child as THREE.Mesh).isMesh) {
			const mesh = child as THREE.Mesh;
			const geometry = mesh.geometry;
			const position = geometry.attributes.position;
			const index = geometry.index;
			const worldMatrix = mesh.matrixWorld;

			// add vertices (transformed by world matrix)
			for (let i = 0; i < position.count; i++) {
				const vec = new THREE.Vector3(
					position.getX(i),
					position.getY(i),
					position.getZ(i),
				);
				vec.applyMatrix4(worldMatrix);
				positions.push(vec.x, vec.y, vec.z);
			}

			// add indices (offset by current vertex count)
			if (index) {
				for (let i = 0; i < index.count; i++) {
					indices.push(index.getX(i) + vertexOffset);
				}
			} else {
				for (let i = 0; i < position.count; i++) {
					indices.push(i + vertexOffset);
				}
			}

			vertexOffset += position.count;
		}
	});

	return {
		positions: new Float32Array(positions),
		indices: new Uint32Array(indices),
	};
}

// ============================================================================
// Scene Setup
// ============================================================================

async function setupScene(statusElement: HTMLPreElement): Promise<SceneSetup> {
	statusElement.textContent = "Loading model...";

	// Create renderer + camera + controls
	const canvas = document.createElement("canvas");
	document.body.appendChild(canvas);

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

	const camera = new THREE.PerspectiveCamera(
		60,
		window.innerWidth / window.innerHeight,
		0.1,
		1000,
	);
	camera.position.set(0, 5, 10);

	const onResize = () => {
		renderer.setSize(window.innerWidth, window.innerHeight);
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
	};
	onResize();
	window.addEventListener("resize", onResize);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.target.set(0, 1, 0);
	controls.update();

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x222222);

	// Add lights
	const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.7);
	hemi.position.set(0, 20, 0);
	scene.add(hemi);

	const dir = new THREE.DirectionalLight(0xffffff, 0.8);
	dir.position.set(5, 10, 7.5);
	scene.add(dir);

	// Load model
	const glbScene = await loadGLB("/nav-test.glb");
	scene.add(glbScene);

	// Start animation loop
	function animate() {
		requestAnimationFrame(animate);
		controls.update();
		renderer.render(scene, camera);
	}
	animate();

	// Extract geometry
	statusElement.textContent = "Extracting geometry...";
	const { positions, indices } = gatherTrianglesFromScene(glbScene);
	statusElement.textContent = `Triangles: ${indices.length / 3}, Vertices: ${positions.length / 3}`;

	return { renderer, scene, camera, controls, positions, indices };
}

// ============================================================================
// Recast Initialization
// ============================================================================

async function initializeRecast(): Promise<number> {
	const start = performance.now();
	await recastNavigation.init();
	const end = performance.now();
	const initTime = end - start;
	console.log(`Recast init: ${initTime.toFixed(2)}ms`);
	return initTime;
}

// ============================================================================
// Generation Benchmarks
// ============================================================================

function createGenerationOptions(): GenerationOptions {
	const cellSize = 0.15;
	const cellHeight = 0.3;
	const walkableClimbWorld = 0.5;
	const walkableHeightWorld = 1.0;
	const walkableRadiusWorld = 0.2;

	return {
		cellSize,
		cellHeight,
		walkableRadiusVoxels: Math.ceil(walkableRadiusWorld / cellHeight),
		walkableRadiusWorld,
		walkableClimbVoxels: Math.ceil(walkableClimbWorld / cellHeight),
		walkableClimbWorld,
		walkableHeightVoxels: Math.ceil(walkableHeightWorld / cellHeight),
		walkableHeightWorld,
		walkableSlopeAngleDegrees: 45,
		borderSize: 0,
		minRegionArea: 8,
		mergeRegionArea: 20,
		maxSimplificationError: 1.3,
		maxEdgeLength: 6.0,
		maxVerticesPerPoly: 6,
		detailSampleDistance: 5.0,
		detailSampleMaxError: 1.3,
	};
}

async function benchmarkGeneration(
	positions: Float32Array,
	indices: Uint32Array,
	options: GenerationOptions,
	statusElement: HTMLPreElement,
): Promise<GenerationResults> {
	// Recast generation
	statusElement.textContent = "Benchmarking Recast generation...";
	let recastNav: recastNavigation.NavMesh | undefined;

	const recastOptions = {
		cs: options.cellSize,
		ch: options.cellHeight,
		walkableRadius: options.walkableRadiusVoxels,
		walkableClimb: options.walkableClimbVoxels,
		walkableHeight: options.walkableHeightVoxels,
		walkableSlopeAngle: options.walkableSlopeAngleDegrees,
		borderSize: options.borderSize,
		minRegionArea: options.minRegionArea,
		mergeRegionArea: options.mergeRegionArea,
		maxSimplificationError: options.maxSimplificationError,
		maxEdgeLen: options.maxEdgeLength,
		maxVertsPerPoly: options.maxVerticesPerPoly,
		detailSampleDist: options.detailSampleDistance,
		detailSampleMaxError: options.detailSampleMaxError,
	};

	const recastGenTime = benchmark("recast generation", () => {
		const result = recastNavigationGenerators.generateSoloNavMesh(
			positions,
			indices,
			recastOptions,
		);
		recastNav = result.navMesh ?? undefined;
	});

	console.log("Recast generation:", recastGenTime);

	if (!recastNav) {
		throw new Error("Recast navmesh generation failed");
	}

	// Navcat generation
	statusElement.textContent = "Benchmarking Navcat generation...";
	let navcatNav: navcat.NavMesh = null!;
	let navcatIntermediates: navcatBlocks.SoloNavMeshIntermediates = null!;

	const navcatInput = { positions, indices };
	const navcatOptions = {
		cellSize: options.cellSize,
		cellHeight: options.cellHeight,
		walkableRadiusVoxels: options.walkableRadiusVoxels,
		walkableRadiusWorld: options.walkableRadiusWorld,
		walkableClimbVoxels: options.walkableClimbVoxels,
		walkableClimbWorld: options.walkableClimbWorld,
		walkableHeightVoxels: options.walkableHeightVoxels,
		walkableHeightWorld: options.walkableHeightWorld,
		walkableSlopeAngleDegrees: options.walkableSlopeAngleDegrees,
		borderSize: options.borderSize,
		minRegionArea: options.minRegionArea * options.minRegionArea, // recast generateSoloNavMesh does this internally
		mergeRegionArea: options.mergeRegionArea * options.mergeRegionArea, // recast generateSoloNavMesh does this internally
		maxSimplificationError: options.maxSimplificationError,
		maxEdgeLength: options.maxEdgeLength,
		maxVerticesPerPoly: options.maxVerticesPerPoly,
		detailSampleDistance: options.cellSize * options.detailSampleDistance, // recast generateSoloNavMesh does this internally
		detailSampleMaxError: options.cellHeight * options.detailSampleMaxError, // recast generateSoloNavMesh does this internally
	};
	const navcatGenTime = benchmark("navcat generation", () => {
		const result = navcatBlocks.generateSoloNavMesh(navcatInput, navcatOptions);
		navcatNav = result.navMesh;
		navcatIntermediates = result.intermediates;
	});

	console.log("Navcat generation:", navcatGenTime);

	return {
		navcatNav,
		navcatIntermediates,
		navcatGenTime,
		recastNav,
		recastGenTime,
	};
}

// ============================================================================
// Visualization
// ============================================================================

function visualizeNavMeshes(
	scene: THREE.Scene,
	genResults: GenerationResults,
): NavMeshVisuals {
	// Navcat navmesh
	const navcatHelper = navcatThree.createNavMeshHelper(genResults.navcatNav);
	navcatHelper.object.position.y = 0.05;
	scene.add(navcatHelper.object);

	// Recast navmesh
	const recastDebugDrawer = new recastNavigationThree.DebugDrawer();
	recastDebugDrawer.drawNavMesh(genResults.recastNav);
	recastDebugDrawer.position.y = 0.1;
	scene.add(recastDebugDrawer);

	return { navcatHelper, recastDebugDrawer };
}

function setupGUI(visuals: NavMeshVisuals, pathVisuals: PathVerification): GUI {
	const gui = new GUI();

	const settings = {
		showNavcatMesh: true,
		showRecastMesh: true,
		showNavcatPath: true,
		showRecastPath: true,
	};

	const meshFolder = gui.addFolder("NavMeshes");
	meshFolder
		.add(settings, "showNavcatMesh")
		.name("Navcat Mesh")
		.onChange((value: boolean) => {
			visuals.navcatHelper.object.visible = value;
		});

	meshFolder
		.add(settings, "showRecastMesh")
		.name("Recast Mesh")
		.onChange((value: boolean) => {
			visuals.recastDebugDrawer.visible = value;
		});
	meshFolder.open();

	const pathFolder = gui.addFolder("Paths");
	pathFolder
		.add(settings, "showNavcatPath")
		.name("Navcat Path (Green)")
		.onChange((value: boolean) => {
			pathVisuals.navcatPathVisuals.visible = value;
		});

	pathFolder
		.add(settings, "showRecastPath")
		.name("Recast Path (Red)")
		.onChange((value: boolean) => {
			pathVisuals.recastPathVisuals.visible = value;
		});
	pathFolder.open();

	return gui;
}

// ============================================================================
// Path Verification
// ============================================================================

function verifyPaths(
	scene: THREE.Scene,
	genResults: GenerationResults,
	statusElement: HTMLPreElement,
): PathVerification {
	statusElement.textContent = "Verifying paths...";

	// Test coordinates
	const startPos = { x: -3.94, y: 0.26, z: 4 };
	const endPos = { x: 2.52, y: 2.39, z: -2.2 };
	const halfExtents = { x: 1, y: 1, z: 1 };

	// Create groups for path visuals
	const navcatPathVisuals = new THREE.Group();
	navcatPathVisuals.name = "Navcat Path (Green)";
	scene.add(navcatPathVisuals);

	const recastPathVisuals = new THREE.Group();
	recastPathVisuals.name = "Recast Path (Red)";
	scene.add(recastPathVisuals);

	// Navcat path
	let navcatPath = null;
	navcatPath = navcat.findPath(
		genResults.navcatNav,
		[startPos.x, startPos.y, startPos.z],
		[endPos.x, endPos.y, endPos.z],
		[halfExtents.x, halfExtents.y, halfExtents.z],
		navcat.DEFAULT_QUERY_FILTER,
	);
	console.log("Navcat path points:", navcatPath?.path.length ?? 0);

	// Visualize navcat path (green)
	if (navcatPath?.path) {
		const navcatPathPoints = navcatPath.path.map(
			(p) => new THREE.Vector3(p.position[0], p.position[1], p.position[2]),
		);
		const navcatPathGeometry = new THREE.BufferGeometry().setFromPoints(
			navcatPathPoints,
		);
		const navcatPathLine = new THREE.Line(
			navcatPathGeometry,
			new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 }),
		);
		navcatPathVisuals.add(navcatPathLine);

		navcatPathPoints.forEach((point: any) => {
			const sphere = new THREE.Mesh(
				new THREE.SphereGeometry(0.1, 8, 8),
				new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
			);
			sphere.position.copy(point);
			navcatPathVisuals.add(sphere);
		});
	}

	// Recast path
	const recastQuery = new recastNavigation.NavMeshQuery(genResults.recastNav);

	let recastPath = null;
	const recastFoundPath = recastQuery.computePath(startPos, endPos);
	console.log("Recast path points:", recastFoundPath.path.length);
	recastPath = recastFoundPath.path;

	// Visualize recast path (red)
	if (recastFoundPath.path.length > 0) {
		const recastPathPoints = recastFoundPath.path.map(
			(p) => new THREE.Vector3(p.x, p.y, p.z),
		);
		const recastPathGeometry = new THREE.BufferGeometry().setFromPoints(
			recastPathPoints,
		);
		const recastPathLine = new THREE.Line(
			recastPathGeometry,
			new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 }),
		);
		recastPathVisuals.add(recastPathLine);

		recastPathPoints.forEach((point: any) => {
			const sphere = new THREE.Mesh(
				new THREE.SphereGeometry(0.1, 8, 8),
				new THREE.MeshBasicMaterial({ color: 0xff0000 }),
			);
			sphere.position.copy(point);
			recastPathVisuals.add(sphere);
		});
	}

	return { navcatPath, recastPath, navcatPathVisuals, recastPathVisuals };
}

// ============================================================================
// Query Benchmarks
// ============================================================================

function benchmarkQueries(
	genResults: GenerationResults,
	statusElement: HTMLPreElement,
): QueryBenchmarkResults {
	statusElement.textContent = "Benchmarking queries...";

	const startPos = { x: -3.94, y: 0.26, z: 4 };
	const endPos = { x: 2.52, y: 2.39, z: -2.2 };
	const halfExtents = { x: 1, y: 1, z: 1 };

	// Recast query benchmark
	const recastQuery = new recastNavigation.NavMeshQuery(genResults.recastNav);

	const recastQueryTime = benchmark(
		"recast query",
		() => {
			recastQuery.computePath(startPos, endPos);
		},
		100,
		10_000,
	);

	console.log(
		`Recast query (${recastQueryTime.runs} iterations):`,
		recastQueryTime,
	);

	// Navcat query benchmark
	const navcatQueryFilter = navcat.DEFAULT_QUERY_FILTER;
	const navcatStart: navcat.Vec3 = [startPos.x, startPos.y, startPos.z];
	const navcatEnd: navcat.Vec3 = [endPos.x, endPos.y, endPos.z];
	const navcatHalfExtents: navcat.Vec3 = [
		halfExtents.x,
		halfExtents.y,
		halfExtents.z,
	];

	const navcatQueryTime = benchmark(
		"navcat query",
		() => {
			navcat.findPath(
				genResults.navcatNav,
				navcatStart,
				navcatEnd,
				navcatHalfExtents,
				navcatQueryFilter,
			);
		},
		100,
		10_000,
	);

	console.log(
		`Navcat query (${navcatQueryTime.runs} iterations):`,
		navcatQueryTime,
	);

	return { navcatQueryTime, recastQueryTime };
}

// ============================================================================
// Results Summary
// ============================================================================

function displaySummary(
	statusElement: HTMLPreElement,
	recastInitTime: number,
	genResults: GenerationResults,
	queryResults: QueryBenchmarkResults,
) {
	const summary = `
=== BENCHMARK RESULTS ===

Recast Init: ${recastInitTime.toFixed(2)}ms

Generation:
  Navcat: ${genResults.navcatGenTime.mean.toFixed(2)}ms ± ${genResults.navcatGenTime.stdDev.toFixed(2)}ms
  Recast: ${genResults.recastGenTime.mean.toFixed(2)}ms ± ${genResults.recastGenTime.stdDev.toFixed(2)}ms

Query (per query, ${queryResults.navcatQueryTime.warmupRuns} warmup + ${queryResults.navcatQueryTime.runs.toLocaleString()} runs):
  Navcat: ${queryResults.navcatQueryTime.mean.toFixed(3)}ms ± ${queryResults.navcatQueryTime.stdDev.toFixed(3)}ms (total: ${(queryResults.navcatQueryTime.mean * queryResults.navcatQueryTime.runs).toFixed(0)}ms)
  Recast: ${queryResults.recastQueryTime.mean.toFixed(3)}ms ± ${queryResults.recastQueryTime.stdDev.toFixed(3)}ms (total: ${(queryResults.recastQueryTime.mean * queryResults.recastQueryTime.runs).toFixed(0)}ms)

Visualization:
  Green = Navcat Path
  Red = Recast Path
  Use GUI to toggle meshes and paths
	`.trim();

	console.log(summary);
	statusElement.textContent = summary;
}

// ============================================================================
// Main Orchestration
// ============================================================================

async function run() {
	// Create status overlay
	const statusElement = document.createElement("pre");
	statusElement.style.position = "fixed";
	statusElement.style.left = "8px";
	statusElement.style.top = "8px";
	statusElement.style.background = "rgba(0,0,0,0.6)";
	statusElement.style.color = "white";
	statusElement.style.padding = "8px";
	statusElement.style.zIndex = "9999";
	statusElement.textContent = "Initializing...";
	document.body.appendChild(statusElement);

	// Setup scene and load model
	const sceneSetup = await setupScene(statusElement);

	// Initialize Recast
	statusElement.textContent = "Initializing Recast...";
	const recastInitTime = await initializeRecast();

	// Create generation options
	const options = createGenerationOptions();

	// Run generation benchmarks
	const genResults = await benchmarkGeneration(
		sceneSetup.positions,
		sceneSetup.indices,
		options,
		statusElement,
	);

	// Visualize navmeshes
	const visuals = visualizeNavMeshes(sceneSetup.scene, genResults);

	// Verify paths
	const pathVisuals = verifyPaths(sceneSetup.scene, genResults, statusElement);

	// Setup GUI controls
	setupGUI(visuals, pathVisuals);

	// Run query benchmarks
	const queryResults = benchmarkQueries(genResults, statusElement);

	// Display summary
	displaySummary(statusElement, recastInitTime, genResults, queryResults);
}

// run when loaded in browser
run().catch((err) => {
	console.error(err);
	const e = document.createElement("pre");
	e.textContent = String(err.stack || err);
	document.body.appendChild(e);
});
