/// <reference path="../types/api-response.d.ts" />
import fetch, { Response } from "node-fetch";
import npmPackageArg from "npm-package-arg";
import semver from "semver";
import fs from "fs";
import path from "path";
import { StatusCode } from "status-code-enum";
import { TriState, TriStates } from "./tristate";

export type PackageFullName = string;
export type PackageName = string;
export type PackageSemanticVersion = string;
export type PackageVersion = string;


type APIRequest = {
    name: PackageName,
    version?: PackageVersion
}

export const LATEST: PackageVersion = "latest";

enum Errors {
    NO_TARBALL = "no tarball",
    NOT_FOUND = "not found",
    PACKAGE_DOESNT_EXIST_IN_REGISTRY = "package doesn't exist in registry",
    TOO_MANY_FAILURES = "too many failures",
    UNKNOWN_ERROR = "unknown error"
}

function fullNameByNameAndVersion(name: string, version: string): PackageFullName {
    return `${name}@${version}`;
}
function compactResponse(apiResponse: APIResponse) {
    Object.getOwnPropertyNames(apiResponse).forEach(key => {
        // ---- for maintaing static referencing: -----
        (<APIPackageResponse>apiResponse).versions;
        (<APIVersionResponse>apiResponse).dist;
        (<APIVersionResponse>apiResponse).dependencies;
        // --------------------------------------------
        if(key === "versions" || key === "dist" || key === "dependencies" ) {
            return;
        }
        delete (<{ [key: string] : any }>apiResponse)[key];
    });
}
export default class Package {
    static readonly MAX_TRIES: number = 3;

    public dependencies: Package[] = [];
    public dependents: Package[] = [];
    public error: boolean = false;
    public existsInRegistry: TriState = TriStates.UNKNOWN;
    public loading: boolean = false;
    public name: string;
    public resolved: boolean = false;
    public tarballURL: string | undefined;
    public version: string;

    static cache: Map<PackageFullName, Package> = new Map();
    static apiCache: Map<PackageName, APIPackageResponse> = new Map();

    public get isRoot(): boolean {
        return this.dependents.length === 0;
    }
    public get fullName(): PackageFullName {
        return fullNameByNameAndVersion(this.name, this.version);
    }
    public get tgzFileName(): string | undefined {
        if (!this.tarballURL) {
            return;
        }
        return path.basename(this.tarballURL!);
    }
    protected constructor(name: string, version?: string) {
        this.name = name;
        this.version = version ?? LATEST;
    }

    public addDependent(pkg: Package) {
        if (!this.dependents.includes(pkg)) {
            this.dependents.push(pkg);
        }
    }

    public async download(): Promise<void> {
        if (!this.tarballURL || !this.tgzFileName) {
            throw "not enough data for download tgz file";
        }
        console.log(`downloading ${this}...`);
        let triesCount = 0;
        let tgzFileData: Buffer;
        do {
            try {
                const response = await fetch(this.tarballURL!);
                if (!response) continue;
                tgzFileData = await response.buffer();
                if (!tgzFileData) continue;
                break;
            } catch (error) {
                // TODO: different errors
            }
        } while (++triesCount < Package.MAX_TRIES);
        if (triesCount == Package.MAX_TRIES) throw "`downloading ${this} failed`";
        fs.writeFileSync(path.resolve(process.cwd(), this.tgzFileName), tgzFileData!);
        // TODO: add shasum check.
    }
    async getDependencies(): Promise<Package[]> {
        this.loading = true;
        const result: Package[] = [];
        let responseBodyAsJSON: APIVersionResponse;
        try {
            responseBodyAsJSON = <APIVersionResponse> await Package.apiRequest({ name: this.name, version: this.version });
        } catch (error) {
            switch (error) {
                case Errors.PACKAGE_DOESNT_EXIST_IN_REGISTRY:
                    this.existsInRegistry = false;
                    console.log(`pacakge ${this} doesn't exist`);
                    return result;
                default:
                    this.error = true;
                    this.loading = false;
                    throw error;
            }
        }
        if(!responseBodyAsJSON) { // shouldn't happen. no idea what can cause it.
            this.error = true;
            this.loading = false;
            throw Errors.UNKNOWN_ERROR;
        }
        this.tarballURL = responseBodyAsJSON!.dist?.tarball;
        if (responseBodyAsJSON!.dependencies == undefined) { // special case: dependencies node doesn't exist, but tarball exists.
            return result;
        }

        for (const pkg of Object.entries(responseBodyAsJSON!.dependencies)) {
            const packageName = pkg[0];
            const packageSemanticVersion = pkg[1];

            const dependency = await Package.fromSemanticVersion(packageName, packageSemanticVersion);
            // check for cyclic dependency (I.E. https://registry.npmjs.org/@types/koa-compose/latest)
            if (this.isAncestorEqual(dependency)) {
                continue;
            }
            dependency.addDependent(this);
            result.push(dependency);
        }

        this.dependencies = result;
        return result;
    }
    public isAncestorEqual(pkg: Package): boolean {
        if (pkg.isEqual(this)) {
            return true;
        }
        if (this.isRoot) {
            return false;
        }
        return this.dependents.some((dependent) => dependent.isAncestorEqual(pkg));
    }
    public isEqual(pkg: Package): boolean {
        return pkg.fullName === this.fullName;
    }
    public toString(): string {
        return this.fullName;
    }

    public static async apiRequest(apiRequest: APIRequest): Promise<APIResponse> {
        const cachedResponse = Package.apiCache.get(apiRequest.name);
        if (cachedResponse) {
            if (apiRequest.version) {
                return cachedResponse!.versions![apiRequest.version!];
            } else {
                return cachedResponse;
            }
        }

        if (!apiRequest.version) {
            apiRequest.version = "";
        }

        let apiResponse: APIResponse;
        let triesCount = 0;
        do {
            let response: Response | undefined = undefined;
            try {
                response = await fetch(`https://registry.npmjs.org/${apiRequest.name}/${apiRequest.version!}`); // `npm view` returns inconsistent format. so i made direct call to registry
            } catch (error) {
                // TODO: Different errors
            }
            if (!response) {
                continue;
            }
            if (!response.ok) {
                switch (response.status) {
                    case StatusCode.ClientErrorNotFound:
                        if (apiRequest.version === "" || apiRequest.version === LATEST) {
                            throw Errors.PACKAGE_DOESNT_EXIST_IN_REGISTRY;
                        }
                        else {
                            try {
                                const fullResponse = <APIPackageResponse> await Package.apiRequest({ name: apiRequest.name });
                                if (!fullResponse.versions) {
                                    throw Errors.PACKAGE_DOESNT_EXIST_IN_REGISTRY;
                                }
                                if (!Object.keys(fullResponse.versions).includes(apiRequest.version!)) {
                                    throw Errors.PACKAGE_DOESNT_EXIST_IN_REGISTRY;
                                }
                            } catch (error) {
                                switch (error) {
                                    case Errors.PACKAGE_DOESNT_EXIST_IN_REGISTRY:
                                        throw error;
                                    default:
                                        continue;
                                }
                            }

                        }
                    default:
                        throw response.statusText;
                }
            }
            try {
                apiResponse = await <APIResponse>(<unknown>(response.json()));
                if (!apiResponse) {
                    continue;
                }
            } catch (error) {
                continue;
                // TODO: Different errors
            }
            compactResponse(apiResponse!);
            break;
        } while (++triesCount < Package.MAX_TRIES);
        if (triesCount == Package.MAX_TRIES) {
            throw Errors.TOO_MANY_FAILURES;
        }
        if (apiRequest.version == "") {
            Package.apiCache.set(apiRequest.name, apiResponse!);
        }
        return apiResponse!;
    }
    static fillCacheByFullNames(fullNames: PackageFullName[]) {
        for (const fullName of fullNames) {
            const pkg = Package.fromString(fullName);
            if (pkg === undefined) continue;
            pkg!.resolved = true;
            this.cache.set(fullName, pkg);
        }
    }
    public static fromNameAndVersion(name: string, version: string): Package {
        const fullName = fullNameByNameAndVersion(name, version);
        const cachedPkg = Package.cache.get(fullName);
        if (cachedPkg) {
            return cachedPkg;
        } else {
            const result = new Package(name, version);
            this.cache.set(result.fullName, result);
            return result;
        }
    }
    public static async fromSemanticVersion(name: PackageName, semanticVersion: PackageSemanticVersion): Promise<Package> {
        let version: string = semanticVersion;
        if (semanticVersion === "*") {
            version = LATEST;
        } else if (semanticVersion.includes("^") ||
            semanticVersion.includes("~") ||
            semanticVersion.includes(">") ||
            semanticVersion.includes("<") ||
            semanticVersion.includes("-") ||
            semanticVersion.includes("||") ||
            semanticVersion.includes("=v") ||
            semanticVersion.includes(".x")) {
            let apiResponse: APIResponse;
            try {
                apiResponse = <APIPackageResponse> await Package.apiRequest({ name: name });

            } catch (error) {
                throw error;
            }
            version = semver.maxSatisfying(Object.keys(apiResponse!.versions!), semanticVersion) ?? LATEST;
        } else {
            version = semver.coerce(semanticVersion)?.version ?? LATEST;
        }
        return this.fromNameAndVersion(name, version);
    }
    static fromString(pacakgeNameInAnyFormat: string): Package | undefined {
        try {
            const pacakgeArgResult = npmPackageArg(pacakgeNameInAnyFormat);
            const packageName: string = pacakgeArgResult.name!;
            const packageVersion: string | undefined =
                pacakgeArgResult.fetchSpec ?? LATEST;
            return Package.fromNameAndVersion(packageName, packageVersion);
        } catch (ex) {
            return undefined;
        }
    }
}