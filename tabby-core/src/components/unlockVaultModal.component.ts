import { Component, ViewChild, ElementRef } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

/** @hidden */
@Component({
    templateUrl: './unlockVaultModal.component.pug',
})
export class UnlockVaultModalComponent {
    passphrase: string
    @ViewChild('input') input: ElementRef

    constructor (
        private modalInstance: NgbActiveModal,
    ) { }

    ngOnInit (): void {
        setTimeout(() => {
            this.input.nativeElement.focus()
        })
    }

    ok (): void {
        // Password managers and macOS autofill can populate the native input
        // without Angular's ngModel receiving an input event. Prefer ngModel,
        // then fall back to the actual field value so a valid visible password
        // is never submitted as `undefined` to the vault crypto code.
        const passphrase = this.passphrase || this.input?.nativeElement?.value
        if (typeof passphrase !== 'string' || !passphrase.length) {
            this.input?.nativeElement?.focus()
            return
        }
        this.modalInstance.close({
            passphrase,
        })
    }

    cancel (): void {
        this.modalInstance.close(null)
    }

}
